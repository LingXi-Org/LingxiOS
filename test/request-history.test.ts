import assert from 'node:assert/strict'
import { it } from 'node:test'
import { durableProtocol } from './protocol-fixture.js'
import { snapshotRequest } from '../src/context/request.js'
import type { HostPort } from '../src/host/port.js'
import type { ModelDriver, ModelTurnRequest } from '../src/model/driver.js'
import type { ModelItem, SessionRecord, TurnContext, WorkCompletion } from '../src/protocol/types.js'
import { sessionKeyOf } from '../src/protocol/types.js'
import { AgentRuntime } from '../src/runtime/runtime.js'
import { archivePriorRequest, projectRequestHistory } from '../src/context/request-history.js'
import { compactIfNeeded, DEFAULT_COMPACTION, estimateTokens } from '../src/runtime/compaction.js'
import { MemorySessionStore } from './memory-store-fixture.js'
import { closePendingCallsForWait } from '../src/runtime/wait.js'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS } from '../src/index.js'
import { createWorker } from '../src/worker/index.js'
import { OpenAIChatDriver } from '../src/model/openai.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import { nullLogger } from '../src/logging.js'

const graphText = 'Create a diagram of Gather and Check.'
const arithmeticText = 'Reply with only the numeric result of 17 + 26.'
function context(id: string, text: string): TurnContext {
  return { work: { id, tenantId: 't', agentId: 'a', sessionId: 's', principalId: 'u', kind: 'turn',
    lane: 'interactive', triggerRef: `message:${id}`, fence: 1, homeEpoch: 1, leaseToken: 'lease',
    meta: { mode: 'chat', codeExecution: 'disabled', deliveryMode: 'text' } },
  persona: { name: 'Assistant', role: 'assistant', instructions: '' }, capabilities: [],
  messages: [{ ref: `message:${id}`, authorId: 'u', authorName: 'User', authorKind: 'human', body: text, createdAt: 'now' }] }
}
const oldCall: ModelItem = { type: 'function_call', name: 'fixture__save', callId: 'old-call', stepId: 'old-step', arguments: '{"diagram":"Gather → Check"}' }
const oldOutput: ModelItem = { type: 'function_call_output', callId: 'old-call',
  output: '{"ok":true,"receipt":{"runId":"graph","requestVersion":1,"activationId":"old-activation"}}' }
function stored(previous: TurnContext, history: ModelItem[]): SessionRecord {
  return { key: sessionKeyOf(previous.work), tenantId: 't', agentId: 'a', sessionId: 's', history: structuredClone(history),
    request: snapshotRequest(previous), appliedWorkIds: [previous.work.id], revision: 2, compactionEpoch: 0 }
}
async function run(current: TurnContext, initial: SessionRecord) {
  let session: SessionRecord = JSON.parse(JSON.stringify(initial)), input: ModelTurnRequest | undefined, completed: WorkCompletion | undefined, committed = false
  const recovery: string[] = [], effects: string[] = []
  const receipt = { action: 'fixture.save', idempotencyKey: JSON.stringify([current.work.id, 'old-step', 0]),
    result: { ok: true as const, value: { saved: true } } }
  const host: HostPort = { ...durableProtocol(), claimWork: async () => null, heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ ...current, tools: [{ name: 'fixture__save', action: 'fixture.save', description: 'Save fixture',
      effect: 'idempotent', approval: false, parameters: { type: 'object', properties: { diagram: { type: 'string' } }, required: ['diagram'], additionalProperties: false } }] }),
    loadSession: async () => JSON.parse(JSON.stringify(session)), saveSession: async (_work, next) => { session = JSON.parse(JSON.stringify(next)) }, emitEvent: async () => {},
    recoverStep: async (work, id) => { recovery.push(`${work.id}:${id}:step`); return null },
    recoverCell: async (work, id) => { recovery.push(`${work.id}:${id}:cell`); return [receipt] },
    executeAction: async (_work, action) => { effects.push(action.action); return { ok: true, value: { requestVersion: 1, pending: [], truncated: false } } },
    commitResult: async () => { committed = true }, completeWork: async (_work, result) => { completed = result }, yieldWork: async () => {} }
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async () => { throw new Error('unexpected structured call') },
    run: async request => { input = request; return { text: '43', output: [{ role: 'assistant', content: '43' }],
      usage: { available: true, inputTokens: 20, outputTokens: 1 } } } }
  await new AgentRuntime(host, model, { execute: async () => { throw new Error('unexpected kernel') } }).runWork(current.work)
  assert.ok(input, 'generation must be reached')
  assert.equal(committed, true, JSON.stringify(completed))
  return { session, input, recovery, effects }
}

for (const scenario of ['failed-graph', 'successful-graph', 'same-text-new-work', 'explicit-continuation'] as const) {
  it(`archives prior native history for ${scenario} without losing facts`, async () => {
    const previous = context('graph', graphText)
    const history = [oldCall, oldOutput, ...(scenario === 'successful-graph' ? [{ role: 'assistant' as const, content: 'Saved graph reference.' }] : [])]
    const current = context('new-work', scenario === 'same-text-new-work' ? graphText
      : scenario === 'explicit-continuation' ? 'Continue the previous Gather and Check diagram; reuse the checked saved draft.' : arithmeticText)
    const result = await run(current, stored(previous, history))
    assert.equal(result.input.items.some(item => 'type' in item), false, 'previous work cannot supply live native call/output turns')
    const blocks = result.input.items.flatMap(item => { try { return 'role' in item ? [JSON.parse(item.content)] : [] } catch { return [] } })
    const active = blocks.filter(block => block.trust === 'request')
    assert.equal(active.length, 1)
    assert.equal(active[0].content, current.messages[0]!.body)
    const archive = blocks.filter(block => block.trust === 'observation')
    assert.match(JSON.stringify(archive), /Gather/)
    assert.match(JSON.stringify(archive), /old-activation/)
    assert.match(JSON.stringify(archive), /old-call/)
    assert.deepEqual(result.recovery, [])
    assert.equal(result.effects.includes('fixture.save'), false)
    for (const [i, original] of history.entries()) for (const [key, value] of Object.entries(original)) {
      assert.deepEqual(Reflect.get(result.session.history[i]!, key), value, 'durable original bytes and roles remain unchanged')
    }
  })
}

it('does not recover an unpaired historical call under a new work or invent its output', async () => {
  const result = await run(context('arithmetic', arithmeticText), stored(context('graph', graphText), [oldCall]))
  assert.deepEqual(result.recovery, [], 'no old pending call may be recovered with the new work lease')
  assert.equal(result.effects.includes('fixture.save'), false)
  assert.equal(result.session.history.some(item => 'type' in item && item.type === 'function_call_output' && item.callId === 'old-call'), false)
  assert.equal(result.input.items.some(item => 'type' in item), false)
  assert.match(JSON.stringify(result.input.items), /old-call/)
})

it('retains same-work native recovery and its real ledger receipt', async () => {
  const current = context('graph', graphText)
  const result = await run(current, stored(current, [oldCall]))
  assert.deepEqual(result.recovery, ['graph:old-step:step', 'graph:old-step:cell'])
  assert.equal(result.input.items.filter(item => 'type' in item).length, 2)
  assert.deepEqual(result.input.items.find(item => 'type' in item && item.type === 'function_call'), oldCall)
  assert.equal(result.effects.includes('fixture.save'), false, 'ledger result is reused instead of reexecuting')
})

it('does not confuse a work-specific request snapshot with the owner of shared history', async () => {
  const store = new MemorySessionStore()
  const waiting = stored(context('waiting', 'Wait for input.'), [])
  waiting.revision = 0
  const first = await store.save(waiting)
  assert.ok(first.ok)
  const other = stored(context('other', graphText), [oldCall])
  other.revision = first.revision
  other.appliedWorkIds = ['waiting', 'other']
  assert.ok((await store.save(other)).ok)
  const overlaid = await store.get(waiting.key, 'waiting')
  assert.equal(overlaid?.request?.workId, 'waiting')
  const result = await run(context('waiting', 'Wait for input.'), overlaid!)
  assert.deepEqual(result.recovery, [], 'overlaid current snapshot must not rebind another work pending call')
  assert.equal(result.input.items.some(item => 'type' in item), false)
})

it('does not attribute a mixed legacy history to the latest request', () => {
  const legacy = stored(context('latest', graphText), [oldCall, oldOutput, { role: 'assistant', content: 'An older unrelated response.' }])
  legacy.appliedWorkIds = ['first', 'graph', 'latest']
  archivePriorRequest(legacy, 'next')
  for (const item of legacy.history) assert.deepEqual(item.historySource, { workId: null, requestVersion: null })
})

it('compacts the authorized projected view when archive framing crosses the existing limit', async () => {
  const history: ModelItem[] = Array.from({ length: 25 }, () => ({ role: 'assistant', content: 'old', historySource: { workId: 'graph', requestVersion: 1 } }))
  const session = stored(context('next', arithmeticText), history)
  const options = { ...DEFAULT_COMPACTION, contextWindowTokens: 8000, softRatio: .5, hardRatio: .9, keepTailItems: 0, maxSummaryChars: 512 }
  assert.ok(estimateTokens(history) < options.contextWindowTokens * options.softRatio)
  assert.ok(estimateTokens(projectRequestHistory(history)) > options.contextWindowTokens * options.hardRatio)
  let calls = 0
  const model: ModelDriver = { run: async () => { throw new Error('unexpected generation') }, structured: async () => { throw new Error('unexpected structured') },
    compact: async request => { calls++; assert.equal(request.items.some(item => 'type' in item), false)
      return { value: JSON.stringify({ observedResults: 'Prior observations retained.', decisions: '', remainingWork: '', uncertainties: 'Prior completion was not inferred.' }),
        model: 'mock', usage: { available: true, inputTokens: 10, outputTokens: 5 } } } }
  const result = await compactIfNeeded(session, '', model, options, undefined, 0, false, projectRequestHistory)
  assert.equal(result.compacted, true)
  assert.ok(calls > 0)
})

it('keeps reused provider call IDs attached to their own preceding call and proven version', () => {
  const current = context('current', arithmeticText)
  const history: ModelItem[] = [
    { ...oldCall, historySource: { workId: 'old', requestVersion: 2 } }, oldOutput,
    { ...oldCall, stepId: 'current-step', arguments: '{"diagram":"new"}' },
    { type: 'function_call_output', callId: 'old-call', output: 'CURRENT_RECEIPT' },
  ]
  const session = stored(current, history)
  archivePriorRequest(session, current.work.id, [{ id: 'current-step', kind: 'fixture__save', requestVersion: 3,
    input: { callId: 'old-call', arguments: '{"diagram":"new"}' }, artifacts: [] }])
  assert.deepEqual(session.history.map(item => item.historySource), [
    { workId: 'old', requestVersion: 2 }, { workId: 'old', requestVersion: 2 },
    { workId: 'current', requestVersion: 3 }, { workId: 'current', requestVersion: 3 },
  ])
  const projected = projectRequestHistory(session.history, 'current')
  assert.deepEqual(projected.filter(item => 'type' in item).map(item => 'output' in item ? item.output : item.arguments), ['{"diagram":"new"}', 'CURRENT_RECEIPT'])
  assert.match(JSON.stringify(projected.filter(item => 'role' in item)), /old-activation/)
  const interleaved = stored(current, [
    { ...oldCall, historySource: { workId: 'current', requestVersion: 3 } },
    { ...oldOutput, historySource: { workId: 'old', requestVersion: 2 } },
    { ...oldOutput, output: 'CURRENT_RECEIPT' },
  ])
  archivePriorRequest(interleaved, 'current')
  assert.deepEqual(interleaved.history[2]!.historySource, { workId: 'current', requestVersion: 3 })
})

it('does not close a current legacy pending call with another work receipt sharing its call ID', async () => {
  const current = context('current', arithmeticText)
  const result = await run(current, stored(current, [oldCall, { ...oldOutput, historySource: { workId: 'other', requestVersion: 1 } }]))
  assert.deepEqual(result.recovery, ['current:old-step:step', 'current:old-step:cell'])
  assert.deepEqual(result.session.history[0]!.historySource, { workId: 'current', requestVersion: null })
  assert.deepEqual(result.session.history[1]!.historySource, { workId: 'other', requestVersion: 1 })
  const native = result.input.items.filter(item => 'type' in item)
  assert.equal(native.length, 2)
  assert.doesNotMatch(JSON.stringify(native), /old-activation/)
})

it('preserves unknown historical effects instead of fabricating an input-wait output', () => {
  const session = stored(context('current', arithmeticText), [
    { ...oldCall, historySource: { workId: null, requestVersion: null } },
    { ...oldCall, callId: 'current-unstarted', historySource: { workId: 'current', requestVersion: 1 } },
  ])
  closePendingCallsForWait(session)
  assert.equal(session.history.some(item => 'type' in item && item.type === 'function_call_output' && item.callId === 'old-call'), false)
  const output = session.history.find(item => 'type' in item && item.type === 'function_call_output' && item.callId === 'current-unstarted')
  assert.ok(output && 'output' in output)
  assert.equal(JSON.parse(output.output).executionState, 'not_started')
})

it('filters revoked memory before archiving while preserving original durable bytes', async () => {
  const secret: ModelItem = { ...oldOutput, output: 'SYNTHETIC_REVOKED_MEMORY', memorySources: { version: 1,
    sources: [{ tenantId: 't', scopeType: 'user', scopeId: 'u', epoch: 1, forgottenAt: null }] } }
  const result = await run(context('next', arithmeticText), stored(context('graph', graphText), [oldCall, secret]))
  assert.doesNotMatch(JSON.stringify(result.input.items), /SYNTHETIC_REVOKED_MEMORY/)
  assert.match(JSON.stringify(result.session.history), /SYNTHETIC_REVOKED_MEMORY/)
})

it('restores only the current native call after a serialized work switch and a later same-work restart', async () => {
  const next = context('next', arithmeticText)
  const first = await run(next, stored(context('graph', graphText), [{ ...oldCall, historySource: { workId: 'graph', requestVersion: 1 } }]))
  first.session.history.push({ ...oldCall, stepId: 'new-step', callId: 'new-call', historySource: { workId: 'next', requestVersion: 1 } })
  const restarted = await run(next, JSON.parse(JSON.stringify(first.session)))
  assert.deepEqual(restarted.recovery, ['next:new-step:step', 'next:new-step:cell'])
  assert.deepEqual(restarted.session.history[0]?.historySource, { workId: 'graph', requestVersion: 1 })
  assert.equal(restarted.session.history.some(item => 'type' in item && item.type === 'function_call_output' && item.callId === 'old-call'), false)
  assert.equal(restarted.input.items.filter(item => 'type' in item).length, 2)
})

for (const scenario of ['failed-graph', 'successful-graph', 'same-text-new-work', 'explicit-continuation'] as const) {
  it(`real Worker preserves request history ownership: ${scenario}`, { timeout: 20000 }, async () => {
    const db = new PGlite(), directory = await mkdtemp(join(tmpdir(), 'request-history-'))
    await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
    let tail = Promise.resolve(), graphCalls = 0, effects = 0, currentCalls = 0, phase: 'graph' | 'current' = 'graph'
    const savedResources = new Map<string, string>()
    let resourceChecks = 0
    const acquire = async () => { let release!: () => void; const previous = tail; tail = new Promise<void>(resolve => { release = resolve }); await previous; return release }
    const query: SqlPool['query'] = async (sql, parameters) => { const result = await db.query<Record<string, unknown>>(sql, parameters); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length } }
    const pool: SqlPool = { async query(sql, parameters) { const release = await acquire(); try { return await query(sql, parameters) } finally { release() } },
      async connect() { return { query, release: await acquire() } } }
    const identity = { tenantId: 'tenant', principalId: 'user', agentId: 'agent', sessionId: 'room' }
    const priorRun = `graph-${scenario}`, nextRun = `next-${scenario}`
    const nextText = scenario === 'same-text-new-work' ? graphText : scenario === 'explicit-continuation'
      ? 'Continue the previous Gather and Check diagram using the saved result; do not save it again.' : arithmeticText
    const response = scenario === 'explicit-continuation' ? 'The saved draft contains Gather and Check.'
      : scenario === 'same-text-new-work' ? 'Gather collects; Check reviews.' : '43'
    const requests: Array<{ messages: Array<{ role: string; content?: string; tool_calls?: unknown[] }> }> = []
    const app = await createLingxiOS({ database: pool, logger: nullLogger, homesRoot: directory,
      realtime: { allowDraft: () => false, allowPublicText: () => true }, tools: [{
        name: 'fixture__save', action: 'fixture.save', description: 'Save the synthetic diagram', effect: 'idempotent', approval: false,
        parameters: { type: 'object', properties: {}, additionalProperties: false }, parse: () => ({}), authorize: async () => {},
        execute: async context => { effects++; savedResources.set(context.work.id, 'Gather and Check')
          return { ok: true, value: { saved: 'Gather and Check', receipt: 'SYNTHETIC_SAVED_RECEIPT' } } },
        verify: async (context, _input, value) => { resourceChecks++; const stored = savedResources.get(context.work.id)
          const matches = stored === 'Gather and Check' && (value as { saved?: unknown }).saved === stored
          return { status: matches ? 'passed' : 'failed', evidence: { stored: stored ?? null, matches } } },
      }] })
    const model = new OpenAIChatDriver(`history-${scenario}`, { apiKey: 'fixture', maxAttempts: 1, publicTextProtocol: 'purpose-json-v2',
      recovery: { maxAttempts: 1, totalTimeoutMs: 10000 }, fetchImpl: async (_url, init) => {
        const request = JSON.parse(String(init?.body))
        if (!request.stream) return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"missing":[]}' } }], usage: { prompt_tokens: 11, completion_tokens: 7 } })
        if (phase === 'graph') graphCalls++; else { currentCalls++; requests.push(request) }
        if (phase === 'graph' && graphCalls > 1 && scenario === 'failed-graph') return Response.json({ error: { message: 'Synthetic terminal failure' } }, { status: 503 })
        const tool = phase === 'graph' && graphCalls === 1
        const delta = { content: JSON.stringify({ commentary: '', answer: tool ? '' : phase === 'graph' ? 'Graph saved.' : response,
          outcome: tool ? null : { status: 'satisfied', gaps: [] } }),
          ...(tool ? { tool_calls: [{ index: 0, id: 'reusable-call-id', function: { name: 'fixture__save', arguments: '{}' } }] } : {}) }
        return new Response('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: tool ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 7 } }) + '\n\ndata: [DONE]\n\n')
      } })
    const worker = createWorker({ controlPlane: app, model, logger: nullLogger, kernel: { homesRoot: directory }, worker: { id: 'history-worker', healthPort: 0 } })
    try {
      await app.enqueue({ id: priorRun, ...identity, text: graphText, mode: 'execute', codeExecution: 'disabled', deliveryMode: 'text' })
      await worker.runNext()
      const graphState = await app.readRunState({ ...identity, runId: priorRun })
      assert.equal(graphState?.run.status, scenario === 'failed-graph' ? 'failed' : 'succeeded', JSON.stringify(graphState))
      if (scenario !== 'failed-graph') assert.ok(resourceChecks > 0, 'successful graph requires an actual independent saved-resource check')
      assert.equal(effects, 1)
      const ledgerQuery = 'SELECT * FROM lingxios.agent_action_ledger WHERE idempotency_key::jsonb->>0=$1 ORDER BY idempotency_key'
      const ledgerBefore = await pool.query(ledgerQuery, [priorRun])
      phase = 'current'
      await app.enqueue({ id: nextRun, ...identity, text: nextText, mode: 'chat', codeExecution: 'disabled', deliveryMode: 'text' })
      await worker.runNext()
      const state = await app.readRunState({ ...identity, runId: nextRun })
      assert.equal(state?.run.status, 'succeeded')
      assert.equal(state?.message?.body, response)
      assert.equal(currentCalls, 1)
      assert.equal(effects, 1, 'continuation and repeated text never replay the prior side effect')
      assert.deepEqual(await pool.query(ledgerQuery, [priorRun]), ledgerBefore)
      const newEffects = await pool.query("SELECT * FROM lingxios.agent_action_intents WHERE intent->>'workId'=$1 AND intent->'action'->>'action'='fixture.save'", [nextRun])
      assert.deepEqual(newEffects.rows, [], 'only the current completion inspection may add a new ledger record')
      const wire = requests[0]!
      assert.equal(wire.messages.some(message => message.role === 'tool' || message.tool_calls), false)
      const blocks = wire.messages.flatMap(message => { try { return [JSON.parse(message.content ?? '')] } catch { return [] } })
      assert.deepEqual(blocks.filter(block => block.trust === 'request').map(block => block.content), [nextText])
      const historical = blocks.filter(block => block.trust === 'observation').map(block => String(block.content)).join('\n')
      assert.match(historical, /SYNTHETIC_SAVED_RECEIPT/)
      assert.match(historical, new RegExp(priorRun))
      const session = (await pool.query('SELECT history FROM lingxios.agent_os_sessions')).rows[0]!['history'] as ModelItem[]
      const originalCalls = session.filter(item => 'type' in item && item.type === 'function_call')
      assert.equal(originalCalls.length, 1)
      assert.deepEqual(originalCalls[0]!.historySource, { workId: priorRun, requestVersion: 1 })
    } finally { await worker.stop(); await db.close(); await rm(directory, { recursive: true, force: true }) }
  })
}
