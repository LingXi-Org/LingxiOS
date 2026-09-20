import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_COMPACTION, HardLimitExceededError, boundSummary, compactIfNeeded, prepareCompaction, estimateTokens, summaryItem,
} from '../src/runtime/compaction.js'
import type {
  CompactionRequest, CompactionResult, ModelDriver, ModelTurnRequest, ModelTurnResult,
  StructuredCallRequest, StructuredCallResult,
} from '../src/model/driver.js'
import type { ModelItem, SessionRecord, WorkItem } from '../src/protocol/types.js'
import { DEFAULT_MODEL_BUDGET, executionModel, type ModelCallObservation } from '../src/model/execution.js'
import { fitsModel } from '../src/model/profile.js'

function fakeDriver(overrides: Partial<ModelDriver> = {}): ModelDriver {
  return {
    modelId: 'fake-model',
    run(_request: ModelTurnRequest): Promise<ModelTurnResult> {
      throw new Error('not implemented')
    },
    structured(_request: StructuredCallRequest): Promise<StructuredCallResult> {
      throw new Error('not implemented')
    },
    compact(request: CompactionRequest): Promise<CompactionResult> {
      return Promise.resolve({
        value: JSON.stringify({ observedResults: `summary of ${request.items.length} items`, decisions: '', remainingWork: '', uncertainties: '' }),
        model: 'fake-model',
        usage: { available: true, inputTokens: 10, outputTokens: 5 },
      })
    },
    ...overrides,
  }
}

function session(history: ModelItem[], summary?: string): SessionRecord {
  return {
    key: '[\"t1\",\"a1\",\"s1\",null]', tenantId: 't1', agentId: 'a1', sessionId: 's1',
    history, appliedWorkIds: [], revision: 1, compactionEpoch: 0,
    ...(summary !== undefined ? { summary } : {}),
  }
}

function longHistory(count: number): ModelItem[] {
  return Array.from({ length: count }, (_, i) => ({
    role: 'user' as const,
    content: `message ${i} `.repeat(200), // long enough to cross the soft threshold
  }))
}

it('installs async compaction only on unchanged history and requirements, preserving appended tool outputs', async () => {
  const options = { ...DEFAULT_COMPACTION, contextWindowTokens: 1000, keepTailItems: 2, maxSummaryChars: 640 }
  const original = session([...longHistory(8), { type: 'function_call', callId: 'pending', name: 'tool', arguments: '{}' }, ...longHistory(4)])
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const model = fakeDriver({ compact: async request => { await gate; return fakeDriver().compact(request) } })
  const candidate = prepareCompaction(original, model, options)
  const expected = structuredClone(original.history)
  assert.deepEqual(original.history, expected)
  original.history.push({ type: 'function_call_output', callId: 'pending', output: 'completed' })
  finish(); await candidate.settled
  assert.equal(candidate.install(original).compacted, true)
  assert.ok(original.history.some(item => 'type' in item && item.type === 'function_call' && item.callId === 'pending'))
  assert.deepEqual(original.history.at(-1), { type: 'function_call_output', callId: 'pending', output: 'completed' })
  assert.equal(candidate.install(original).compacted, false)

  for (const change of ['history', 'request'] as const) {
    const current = session(longHistory(10))
    const stale = prepareCompaction(current, fakeDriver(), options)
    if (change === 'history') current.history[0] = { role: 'user', content: 'new version' }
    else current.request = { revisions: [{ id: 'revision' }] } as never
    const revised = structuredClone(current)
    await stale.settled
    assert.equal(stale.install(current).compacted, false)
    assert.deepEqual(current, revised)
  }
})

describe('compaction through the execution budget', () => {
  function metered(compact: ModelDriver['compact'], maxModelCalls = 128) {
    const observations: ModelCallObservation[] = [], reservations: string[] = []
    const source = fakeDriver({ contextWindowTokens: 128_000, maxOutputTokens: 8192, compact: async request => {
      const { prompt: _prompt, signal: _signal, ...input } = request
      assert.equal(fitsModel(source, input), true, 'every provider request must fit with output reserved')
      return compact(request)
    } })
    const model = executionModel({ reserveModelCall: async (_work, id) => {
      reservations.push(id)
      return { allowed: true, remainingCalls: 128, remainingTokens: 1_000_000, remainingCostMicros: 10_000_000,
        deadlineAt: new Date(Date.now() + 60_000).toISOString() }
    }, recordModelUsage: async (_work, _id, _usage, observation) => { observations.push(observation!) } }, source,
    { id: 'compact', fence: 1, tenantId: 't1', agentId: 'a1', sessionId: 's1', kind: 'turn', lane: 'interactive' } as WorkItem,
    { ...DEFAULT_MODEL_BUDGET, maxModelCalls })
    return { model, reservations, observations }
  }

  it('keeps a fitting summary to one metered call', async () => {
    const current = session(longHistory(10))
    const { model, reservations, observations } = metered(fakeDriver().compact)
    const result = await compactIfNeeded(current, '', model, { ...DEFAULT_COMPACTION, contextWindowTokens: 1000, keepTailItems: 2 })
    assert.equal(result.compacted, true)
    assert.equal(reservations.length, 1)
    assert.equal(observations.length, 1)
    assert.deepEqual(result.usage, { model: 'fake-model', available: true, inputTokens: 10, outputTokens: 5 })
  })

  for (const prefix of [
    [{ role: 'user' as const, content: 'x'.repeat(120_000) }],
    Array.from({ length: 75 }, (_, i) => ({ role: 'user' as const, content: `${i}:中文😀\n\"\\`.repeat(500) })),
  ]) it(`recovers an over-budget prefix of ${prefix.length} items without dropping or splitting Unicode`, async () => {
    const tail: ModelItem[] = [{ type: 'function_call', callId: 'tail', name: 'ipython', arguments: '{}' },
      { type: 'function_call_output', callId: 'tail', output: 'result' }, ...longHistory(19)]
    const current = session([...prefix, ...tail]), before = structuredClone(current)
    const fragments: string[] = []
    let previousSummary = ''
    const { model, reservations, observations } = metered(async request => {
      assert.deepEqual(current, before, 'all chunks must finish before changing the session')
      if (previousSummary) assert.deepEqual(request.items[0], summaryItem(previousSummary))
      const fragment = request.items.at(-1)!
      assert.ok('role' in fragment)
      const text = fragment.content.slice(fragment.content.indexOf('\n') + 1)
      assert.equal(Buffer.from(text).toString('utf8'), text)
      fragments.push(text)
      const result = await fakeDriver().compact(request)
      previousSummary = boundSummary(result.value, DEFAULT_COMPACTION.maxSummaryChars)
      return result
    })
    const result = await compactIfNeeded(current, '', model, DEFAULT_COMPACTION)
    assert.equal(result.compacted, true)
    assert.ok(fragments.length > 1)
    assert.equal(fragments.join(''), JSON.stringify(prefix))
    assert.deepEqual(current.history, [summaryItem(previousSummary), ...tail])
    assert.equal(current.compactionEpoch, 1)
    assert.equal(reservations.length, fragments.length)
    assert.deepEqual(observations.map(call => [call.callId, call.purpose, call.status]),
      reservations.map(id => [id, 'compaction', 'succeeded']))
    assert.deepEqual(result.usage, { model: 'fake-model', available: true, inputTokens: 10 * fragments.length, outputTokens: 5 * fragments.length })
  })

  for (const failure of ['invalid_summary', 'model_budget', 'cancelled'] as const) {
    it(`preserves history on ${failure} after an earlier chunk succeeded`, async () => {
      const current = session([{ role: 'user', content: 'private-marker'.repeat(20_000) }, ...longHistory(20)])
      const before = structuredClone(current), stop = new AbortController()
      let calls = 0
      const { model, observations } = metered(async request => {
        calls++
        const result = await fakeDriver().compact(request)
        if (calls === 2 && failure === 'invalid_summary') result.value = 'private-marker invalid JSON'
        if (calls === 2 && failure === 'cancelled') stop.abort(new Error('private-marker cancelled'))
        return result
      }, failure === 'model_budget' ? 1 : 128)
      await assert.rejects(compactIfNeeded(current, '', model, DEFAULT_COMPACTION, stop.signal), (error: unknown) => {
        assert.ok(error instanceof HardLimitExceededError)
        assert.equal(error.diagnostics?.reason, failure)
        assert.equal(error.diagnostics?.completedChunks, 1)
        assert.equal(error.diagnostics?.reservedTokens, 8704)
        assert.ok(error.diagnostics!.requestInputTokens > 0)
        assert.doesNotMatch(JSON.stringify(error.diagnostics), /private-marker/)
        return true
      })
      assert.deepEqual(current, before)
      assert.equal(observations.length, calls)
    })
  }

  it('rejects a completed chunked candidate after history changed', async () => {
    const current = session([{ role: 'user', content: 'x'.repeat(240_000) }, ...longHistory(20)])
    const { model } = metered(fakeDriver().compact)
    const pending = prepareCompaction(current, model, DEFAULT_COMPACTION)
    await pending.settled
    current.history[0] = { role: 'user', content: 'replacement' }
    const before = structuredClone(current)
    assert.deepEqual(pending.install(current), { compacted: false })
    assert.deepEqual(current, before)
  })
})

it('keeps useful pending summaries when reads add evidence or derived checks', async () => {
  const current = session(longHistory(10))
  current.request = { version: 1, workId: 'w', tenantId: 't1', sessionId: 's1', authorId: 'u', sourceRef: 'm',
    originalText: 'Read the sources.', revisions: [], attachments: [], evidence: { version: 1, id: 'e', items: [] } }
  const candidate = prepareCompaction(current, fakeDriver(), { ...DEFAULT_COMPACTION, contextWindowTokens: 1000, keepTailItems: 2, maxSummaryChars: 640 })
  current.request.evidence = { version: 1, id: 'read', items: [{ marker: 'S1', sourceId: 'source', sourceVersion: 'v1', chunkId: 'chunk', title: 'Source', excerpt: 'new fact' }] }
  current.request.resourceChecks = []
  const request = structuredClone(current.request)
  await candidate.settled
  assert.equal(candidate.install(current).compacted, true)
  assert.deepEqual(current.request, request)
})

it('skips tiny background prefixes and never installs a larger summary', async () => {
  const current = session(Array.from({ length: 25 }, () => ({ role: 'user', content: 'small' })))
  let calls = 0
  const model = fakeDriver({ compact: async () => { calls++; return { value: JSON.stringify({ observedResults: 'x'.repeat(3000), decisions: '', remainingWork: '', uncertainties: '' }), model: 'fake', usage: { available: false, inputTokens: 0, outputTokens: 0 } } } })
  const before = structuredClone(current)
  const candidate = prepareCompaction(current, model, { ...DEFAULT_COMPACTION, contextWindowTokens: 100 })
  await candidate.settled
  assert.equal(candidate.install(current).compacted, false)
  assert.equal(calls, 0)
  assert.equal((await compactIfNeeded(current, '', model, { ...DEFAULT_COMPACTION, contextWindowTokens: 100 })).compacted, false)
  assert.deepEqual(current, before)
})

describe('estimateTokens', () => {
  it('uses a conservative byte bound', () => {
    const items: ModelItem[] = [{ role: 'user', content: 'a'.repeat(400) }]
    const estimated = estimateTokens(items)
    const expected = new TextEncoder().encode(JSON.stringify(items)).length
    assert.equal(estimated, expected)
  })
})

describe('summaryItem', () => {
  it('wraps the summary text with the untrusted-context preamble', () => {
    const item = summaryItem('the user asked about X') as { role: string; content: string }
    assert.equal(item.role, 'user')
    assert.match(item.content, /untrusted context/)
    assert.match(item.content, /the user asked about X/)
  })
})

describe('compactIfNeeded', () => {
  it('keeps tool pairs together and folds a prior summary only once', async () => {
    const history: ModelItem[] = [summaryItem('old facts'), ...longHistory(5),
      { type: 'function_call', callId: 'c1', name: 'ipython', arguments: '{}' },
      { type: 'function_call_output', callId: 'c1', output: 'ok' },
      { role: 'assistant', content: 'done' }]
    const s = session(history, 'old facts')
    const driver = fakeDriver({ compact: async (request) => {
      assert.equal(request.items.filter((item) => 'role' in item && item.content.includes('old facts')).length, 1)
      return { value: JSON.stringify({ observedResults: 'new summary', decisions: '', remainingWork: '', uncertainties: '' }), model: 'test', usage: { available: true, inputTokens: 1, outputTokens: 1 } }
    } })
    await compactIfNeeded(s, '', driver, { ...DEFAULT_COMPACTION, contextWindowTokens: 100, keepTailItems: 2 })
    assert.deepEqual(s.history, [summaryItem(s.summary!), ...history.slice(-3)])
  })

  it('closes a moved boundary over newly included tool results', async () => {
    const history: ModelItem[] = [
      { type: 'function_call', callId: 'a', name: 'ipython', arguments: '{}' },
      { type: 'function_call', callId: 'b', name: 'ipython', arguments: '{}' },
      { type: 'function_call_output', callId: 'a', output: 'a' },
      { type: 'function_call_output', callId: 'b', output: 'b' },
      ...longHistory(19),
    ]
    const s = session(history)
    const outcome = await compactIfNeeded(s, '', fakeDriver(), {
      ...DEFAULT_COMPACTION, contextWindowTokens: 100, keepTailItems: 20,
    })
    assert.equal(outcome.compacted, false)
    assert.deepEqual(s.history, history)
  })
  const smallOptions = {
    ...DEFAULT_COMPACTION,
    contextWindowTokens: 1_000,
    keepTailItems: 2,
  }

  it('does nothing when under the soft threshold', async () => {
    const s = session([{ role: 'user', content: 'hi' }])
    const outcome = await compactIfNeeded(s, 'instructions', fakeDriver(), smallOptions)
    assert.equal(outcome.compacted, false)
    assert.equal(s.compactionEpoch, 0)
  })

  it('does nothing when history is not longer than the kept tail', async () => {
    const s = session(longHistory(2))
    const outcome = await compactIfNeeded(s, 'instructions', fakeDriver(), smallOptions)
    assert.equal(outcome.compacted, false)
  })

  it('compacts older history into a summary, keeping the tail verbatim', async () => {
    const history = longHistory(10)
    const s = session(history)
    const outcome = await compactIfNeeded(s, 'instructions', fakeDriver(), smallOptions)
    assert.equal(outcome.compacted, true)
    assert.equal(s.compactionEpoch, 1)
    assert.equal(s.history.length, smallOptions.keepTailItems + 1) // summary + tail
    assert.deepEqual(s.history.slice(1), history.slice(-smallOptions.keepTailItems))
    assert.match(s.summary ?? '', /summary of 8 items/)
  })

  it('bounds each summary field without a second model call or broken JSON', async () => {
    const history = longHistory(10), s = session(history, 'existing summary')
    let calls = 0
    const raw = JSON.stringify({ observedResults: 'x'.repeat(500), decisions: 'Keep receipts.', remainingWork: 'Verify file.', uncertainties: 'Unknown write.' })
    const driver = fakeDriver({ compact: async request => {
      calls++
      assert.match(JSON.stringify(request.items), /existing summary/)
      return { value: raw, model: 'fake-model', usage: { available: true, inputTokens: 10, outputTokens: 5 } }
    } })
    const outcome = await compactIfNeeded(s, '', driver, { ...smallOptions, maxSummaryChars: 640 })
    assert.equal(calls, 1)
    assert.equal(s.summary, boundSummary(raw, 640))
    assert.ok(s.summary!.length <= 640)
    assert.deepEqual(JSON.parse(s.summary!).truncated, ['observedResults'])
    assert.deepEqual(outcome.usage, { model: 'fake-model', available: true, inputTokens: 10, outputTokens: 5 })
  })

  it('tolerates compaction failure below the hard limit', async () => {
    const history = longHistory(10)
    const s = session(history)
    const driver = fakeDriver({
      compact() {
        return Promise.reject(new Error('model unavailable'))
      },
    })
    const outcome = await compactIfNeeded(s, 'instructions', driver, {
      ...smallOptions, hardRatio: 100, // hard limit far above estimated tokens
    })
    assert.equal(outcome.compacted, false)
    assert.equal(s.compactionEpoch, 0)
  })

  it('throws HardLimitExceededError when compaction fails past the hard limit', async () => {
    const history = longHistory(10)
    const s = session(history)
    const driver = fakeDriver({
      compact() {
        return Promise.reject(new Error('model unavailable'))
      },
    })
    await assert.rejects(
      compactIfNeeded(s, 'instructions', driver, { ...smallOptions, hardRatio: 0.0001 }),
      HardLimitExceededError,
    )
  })
})
