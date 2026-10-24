import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createHash } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS } from '../src/index.js'
import { createWorker } from '../src/worker/index.js'
import { OpenAIChatDriver } from '../src/model/openai.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import { LeaseLostError } from '../src/errors.js'
import { nullLogger } from '../src/logging.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const ack = '{"status":"public_message_recorded"}'
const known = 'Gather collects the items. Check reviews them. '
type Reply = { answer: string | null; intermediate?: boolean; partial?: boolean; replace?: boolean; callId?: string }
  | { business: true }
  | { invalid: 'mixed' | 'duplicate' | 'truncated' }
type WireRequest = { stream?: boolean; messages: Array<{ role: string; content?: unknown; tool_call_id?: string; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }> }
async function fixture(replies: Reply[], fault?: 'seal' | 'second-seal' | 'history' | 'cancel' | 'tamper-call' | 'compacted-duplicate' | 'missing-binding', maxCalls = 8, text = 'Gather collects items. Check reviews them. Explain these facts, then save the synthetic record.') {
  const db = new PGlite(), home = await mkdtemp(join(tmpdir(), 'public-answer-worker-'))
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  let tail = Promise.resolve(), calls = 0, effects = 0, auxiliary = 0, seals = 0, faulted = false, strippedBindings = 0
  const saved = new Map<string, string>()
  let resourceChecks = 0
  const requests: WireRequest[] = [], rawPublicCalls: Array<{ id: string; args: string }> = [], timeline: string[] = []
  const acquire = async () => { let release!: () => void; const previous = tail; tail = new Promise<void>(r => { release = r }); await previous; return release }
  const query: SqlPool['query'] = async (sql, params) => { const result = await db.query<Record<string, unknown>>(sql, params); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length } }
  const pool: SqlPool = { async query(sql, params) { const release = await acquire(); try { return await query(sql, params) } finally { release() } }, async connect() { return { query, release: await acquire() } } }
  const app = await createLingxiOS({ database: pool, homesRoot: home, logger: nullLogger,
    delivery: { onEvent: async () => {}, deliverMessage: async () => ({ messageId: 'synthetic-public-output-receipt' }) },
    realtime: { allowPublicText: () => true },
    tools: [{ name: 'probe__save', action: 'probe.save', effect: 'idempotent', approval: false, description: 'Save a synthetic artifact with independent readback.',
      parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
      parse: args => args as Record<string, unknown>, authorize: async () => {}, execute: async context => { effects++; timeline.push('business'); saved.set(context.work.id, 'Gather and Check'); return { ok: true, value: { saved: 'Gather and Check' } } },
      verify: async (context, _input, value) => { resourceChecks++; const stored = saved.get(context.work.id); const matches = stored === 'Gather and Check' && (value as { saved?: unknown }).saved === stored; return { status: matches ? 'passed' : 'failed', evidence: { stored: stored ?? null, matches } } } }] })
  const identity = { runId: 'public-answer-run', tenantId: 'tenant', principalId: 'human', agentId: 'agent', sessionId: 'room' }
  const connect = app.connectWorker.bind(app)
  app.connectWorker = options => {
    const host = connect(options), emit = host.emitEvent.bind(host), saveSession = host.saveSession.bind(host)
    const expire = async (workId: string) => {
      await pool.query("UPDATE lingxios.agent_work_items SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [workId])
      await pool.query("UPDATE lingxios.agent_os_session_leases SET expires_at=NOW()-INTERVAL '1 second' WHERE work_id=$1", [workId])
    }
    host.saveSession = async (work, session, ...rest) => {
      const compactNow = fault === 'compacted-duplicate' && !faulted && Boolean(session.request?.publicTextHistory) && session.history.some(item => 'type' in item && item.type === 'function_call' && item.name === 'public_answer')
      if (compactNow) {
        // Model-history compaction is simulated at its actual persisted boundary.
        // Keep the real sealed step and history cursor; remove only history items.
        faulted = true; session.history = []
      }
      await saveSession(work, session, ...rest)
      if (compactNow) { await expire(work.id); throw new LeaseLostError('synthetic restart after persisted compaction') }
      if (fault === 'history' && !faulted && session.history.some(item => 'type' in item && item.type === 'function_call' && item.name === 'public_answer')) {
        faulted = true; await expire(work.id); throw new LeaseLostError('synthetic lost native history acknowledgement')
      }
    }
    host.emitEvent = async (work, event, signal) => {
      if (fault === 'tamper-call' && event.publicTextRecovery?.version === 2) {
        const recovery = event.publicTextRecovery
        const args = JSON.parse(recovery.publicAnswerCall.arguments) as Record<string, unknown>
        args['answer'] = 'Different text never persisted as deltas.'
        event = { ...event, publicTextRecovery: { ...recovery, publicAnswerCall: { ...recovery.publicAnswerCall, arguments: JSON.stringify(args) } } }
      }
      await emit(work, event, signal)
      if (event.kind === 'public.text.sealed') { seals++; timeline.push('seal') }
      if (fault && fault !== 'history' && fault !== 'tamper-call' && fault !== 'compacted-duplicate' && fault !== 'missing-binding' && !faulted && event.kind === 'public.text.sealed' && (fault !== 'second-seal' || seals === 2)) {
        faulted = true
        if (fault === 'cancel') { await app.cancel(identity); return }
        await expire(work.id)
        throw new LeaseLostError('synthetic lost public-answer seal acknowledgement')
      }
    }
    return host
  }
  const fetchImpl: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as WireRequest
    requests.push(request)
    if (!request.stream) { auxiliary++; throw new Error('No semantic judge is permitted in this synthetic ordinary workflow') }
    const reply = replies[calls++]
    assert.ok(reply, 'the fixture has no unrequested additional model response')
    const frame = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\n`
    const call = (name: string, args: string, index = 0, id = `call-${calls}`) => ({ index, id, type: 'function', function: { name, arguments: args } })
    let wire: string
    if ('business' in reply) wire = frame({ tool_calls: [call('probe__save', '{ "key" : "synthetic-record" }')] }, 'tool_calls')
    else if ('invalid' in reply) {
      const args = JSON.stringify({ operation: { kind: 'append', supersedes: [] }, answer: 'Provisional only.', outcome: null })
      wire = frame({ tool_calls: [call('public_answer', reply.invalid === 'truncated' ? args.slice(0, -1) : args),
        ...(reply.invalid === 'mixed' ? [call('probe__save', '{"key":"synthetic-record"}', 1, 'second')]
          : reply.invalid === 'duplicate' ? [call('public_answer', args, 1, 'second')] : [])] }, 'tool_calls')
    } else {
      const steps = reply.replace ? await pool.query("SELECT input FROM lingxios.agent_steps WHERE kind='runtime.answer_segment' AND work_id=$1 ORDER BY step_seq", [identity.runId]) : { rows: [] }
      const args = JSON.stringify({ operation: { kind: reply.replace ? 'replace' : 'append', supersedes: steps.rows.map(row => String((row['input'] as Record<string, unknown>)['partId'])) },
        answer: reply.answer, outcome: reply.intermediate ? null : { status: reply.partial ? 'partial' : 'satisfied', gaps: reply.partial ? ['Synthetic limitation.'] : [] } })
      const id = reply.callId ?? `call-${calls}`
      rawPublicCalls.push({ id, args })
      wire = frame({ content: 'Private ordinary tool companion.', reasoning_content: 'Private synthetic reasoning.', tool_calls: [call('public_answer', args, 0, id)] }, 'tool_calls')
    }
    return new Response(wire + 'data: [DONE]\n\n')
  }
  const model = new OpenAIChatDriver('public-output-worker-fixture', { apiKey: 'synthetic', publicTextProtocol: 'purpose-json-v3', publicTextContinuation: 'typed-message-v1', publicAnswerTool: 'native-v1',
    maxAttempts: 1, capabilities: { parallelTools: false, jsonObjectWithTools: false }, fetchImpl })
  if (fault === 'missing-binding') {
    const run = model.run.bind(model)
    model.run = async request => { const result = await run(request); assert.ok(result.publicAnswerCall); strippedBindings++; delete result.publicAnswerCall; return result }
    // The execution wrapper normally clones a single-attempt driver. Retain
    // this fault-injected single-attempt instance so the negative is exercised.
    model.singleAttempt = () => model
  }
  const newWorker = (id: string) => createWorker({ controlPlane: app, model, modelBudget: { maxModelCalls: maxCalls }, logger: nullLogger, kernel: { homesRoot: home }, worker: { id, healthPort: 0 } })
  const worker = newWorker('public-output-worker')
  await app.enqueue({ id: identity.runId, ...identity, text, mode: 'execute', codeExecution: 'disabled', deliveryMode: 'auto' })
  return { app, pool, identity, requests, rawPublicCalls, timeline, get calls() { return calls }, get effects() { return effects }, get auxiliary() { return auxiliary }, get resourceChecks() { return resourceChecks }, get strippedBindings() { return strippedBindings },
    async run() { await worker.runNext(); return (await app.readRunState(identity))! },
    async restart() { await worker.stop(); const next = newWorker('recovered-public-output-worker'); try { await next.runNext(); return (await app.readRunState(identity))! } finally { await next.stop() } },
    async nextRun(runId: string) { const nextIdentity = { ...identity, runId }; await app.enqueue({ id: runId, ...nextIdentity, text: 'What is 17 + 26? Only the number.', mode: 'execute', codeExecution: 'disabled', deliveryMode: 'auto' }); await worker.runNext(); return (await app.readRunState(nextIdentity))! },
    async close() { await worker.stop(); await app.stop(); await db.close(); await rm(home, { recursive: true, force: true }) } }
}
function assertNativePair(request: WireRequest, original: { id: string; args: string }) {
  const calls = request.messages.flatMap(message => message.tool_calls ?? []).filter(call => call.id === original.id)
  assert.deepEqual(calls, [{ id: original.id, type: 'function', function: { name: 'public_answer', arguments: original.args } }])
  assert.deepEqual(request.messages.filter(message => message.role === 'tool' && message.tool_call_id === original.id).map(message => message.content), [ack])
  assert.equal(request.messages.filter(message => message.role === 'assistant' && typeof message.content === 'string' && message.content.includes(known)).length, 0, 'do not add a duplicate free-text assistant message beside the native call')
}

it('real Worker delivers terminal public arithmetic in one generation with zero business effect or judge', async () => {
  const f = await fixture([{ answer: '43' }], undefined, 8, 'What is 17 + 26? Reply with only the number.')
  try {
    const state = await f.run()
    assert.equal(state.run.status, 'succeeded'); assert.equal(state.message?.body, '43')
    assert.equal(state.message?.publicTextSources?.bodyHash, hash('43'))
    assert.deepEqual([f.calls, f.effects, f.auxiliary], [1, 0, 0])
    assert.equal((await f.pool.query('SELECT * FROM lingxios.agent_model_budget_calls WHERE work_id=$1', [f.identity.runId])).rows.length, 1)
    const actions = (await f.pool.query("SELECT intent->'action'->>'action' AS action FROM lingxios.agent_action_intents WHERE intent->>'workId'=$1", [f.identity.runId])).rows.map(row => row['action'])
    assert.deepEqual(actions.filter(action => action === 'public_answer' || action === 'public.answer' || action === 'probe.save'), [], JSON.stringify(actions))
    assert.equal((await f.app.readEvents(f.identity)).events.filter(event => event.kind === 'tool.started').length, 0)
  } finally { await f.close() }
})

it('real Worker seals known facts before business execution and appends only missing final text', async () => {
  const f = await fixture([{ answer: known, intermediate: true }, { business: true }, { answer: 'The record was observed.', intermediate: true }, { answer: null }])
  try {
    const state = await f.run(), events = (await f.app.readEvents(f.identity)).events
    assert.equal(state.run.status, 'succeeded'); assert.equal(state.message?.body, known + 'The record was observed.')
    assert.deepEqual([f.calls, f.effects, f.auxiliary], [4, 1, 0])
    assert.deepEqual(f.timeline, ['seal', 'business', 'seal']); assert.ok(f.resourceChecks > 0, 'final commit requires independent saved-resource verification')
    assert.equal(state.message?.publicTextSources?.segments.length, 2)
    assert.equal(state.message?.publicTextSources?.bodyHash, hash(known + 'The record was observed.'))
    assertNativePair(f.requests[1]!, f.rawPublicCalls[0]!)
    assertNativePair(f.requests[3]!, f.rawPublicCalls[0]!)
    assertNativePair(f.requests[3]!, f.rawPublicCalls[1]!)
    assert.equal(events.filter(event => event.kind === 'model.delta').length, 0)
    assert.equal(events.filter(event => event.kind === 'response.committed').length, 1)
    const actions = (await f.pool.query("SELECT intent->'action'->>'action' AS action FROM lingxios.agent_action_intents WHERE intent->>'workId'=$1", [f.identity.runId])).rows.map(row => row['action'])
    assert.deepEqual(actions.filter(action => action === 'probe.save'), ['probe.save'], JSON.stringify(actions))
    assert.deepEqual(actions.filter(action => action === 'public_answer' || action === 'public.answer'), [], 'the protocol ACK is never a business action intent')
    assert.equal((await f.pool.query('SELECT * FROM lingxios.agent_model_budget_calls WHERE work_id=$1', [f.identity.runId])).rows.length, 4)
  } finally { await f.close() }
})

for (const fault of ['seal', 'second-seal', 'history'] as const) it(`durable native call and protocol ACK recover after lost ${fault} response without text or business replay`, async () => {
  const f = await fixture([{ answer: known, intermediate: true }, { business: true }, { answer: 'Observed.', intermediate: true }, { answer: null }], fault)
  try {
    await f.run(); assert.equal(f.calls, fault === 'second-seal' ? 3 : 1)
    const state = await f.restart()
    assert.equal(state.run.status, 'succeeded'); assert.equal(state.run.fence, 2); assert.equal(state.message?.body, known + 'Observed.')
    assert.deepEqual([f.calls, f.effects, f.auxiliary], [4, 1, 0])
    assertNativePair(f.requests[fault === 'second-seal' ? 3 : 1]!, f.rawPublicCalls[0]!)
    if (fault === 'second-seal') assertNativePair(f.requests[3]!, f.rawPublicCalls[1]!)
    const events = (await f.app.readEvents(f.identity)).events
    assert.equal(events.filter(event => event.kind === 'public.text.sealed').length, 2)
    assert.equal(events.filter(event => event.kind === 'public.text.delta').map(event => event.data['text']).join(''), known + 'Observed.')
    assert.equal(events.some(event => 'publicTextRecovery' in event), false)
  } finally { await f.close() }
})

for (const invalid of ['mixed', 'duplicate', 'truncated'] as const) it(`invalid ${invalid} public turn has no seal or business dispatch before truthful correction`, async () => {
  const f = await fixture([{ invalid }, { answer: 'Cannot complete the requested action.', partial: true }])
  try {
    const state = await f.run(), events = (await f.app.readEvents(f.identity)).events
    assert.equal(state.run.status, 'partial'); assert.equal(state.message?.body, 'Cannot complete the requested action.')
    assert.deepEqual([f.calls, f.effects, f.auxiliary], [2, 0, 0])
    assert.equal(events.filter(event => event.kind === 'public.text.sealed').length, 1, 'only the corrected, complete turn may seal')
    assert.equal(events.filter(event => event.kind === 'tool.started').length, 0)
    assert.equal(JSON.stringify(f.requests[1]).includes('public_message_recorded'), false, 'an invalid call cannot acquire a fabricated ACK')
  } finally { await f.close() }
})

it('failed replacement retains the prior answer and its original source without repeating the business action', async () => {
  const f = await fixture([{ answer: known, intermediate: true }, { business: true }, { answer: 'Bad [citation](#cite-S999).', replace: true }, { answer: null }, { answer: null }])
  try {
    const state = await f.run()
    assert.equal(state.run.status, 'partial'); assert.equal(state.message?.body, known.trim())
    assert.equal(state.message?.envelope.goalOutcome.verification, 'inconclusive')
    assert.equal(state.message?.publicTextSources?.segments.length, 1); assert.equal(f.effects, 1)
    const steps = await f.pool.query("SELECT input FROM lingxios.agent_steps WHERE kind='runtime.answer_segment' AND work_id=$1 ORDER BY step_seq", [f.identity.runId])
    assert.equal(steps.rows.length, 2, 'failed replacement remains archived, not committed')
    assert.equal(state.message?.publicTextSources?.segments[0]?.partId, (steps.rows[0]!['input'] as Record<string, unknown>)['partId'])
  } finally { await f.close() }
})

it('cancellation after durable public seal prevents subsequent model or business dispatch', async () => {
  const f = await fixture([{ answer: known, intermediate: true }, { business: true }], 'cancel')
  try {
    const state = await f.run()
    assert.equal(state.run.status, 'cancelled'); assert.equal(state.message, null)
    assert.deepEqual([f.calls, f.effects], [1, 0])
    assert.equal((await f.app.readEvents(f.identity)).events.filter(event => event.kind === 'response.committed').length, 0)
  } finally { await f.close() }
})

it('a new run in the same conversation may reuse a provider call ID without reviving old output or actions', async () => {
  const f = await fixture([{ answer: 'Previous task answer.', callId: 'reused' }, { answer: '43', callId: 'reused' }])
  try {
    const old = await f.run(); assert.equal(old.run.status, 'succeeded')
    const next = await f.nextRun('another-run')
    assert.equal(next.run.status, 'succeeded'); assert.equal(next.message?.body, '43')
    assert.deepEqual([f.calls, f.effects, f.auxiliary], [2, 0, 0])
    assert.equal(next.message?.publicTextSources?.messageId, 'answer:another-run:v1')
    assert.equal(next.message?.publicTextSources?.bodyHash, hash('43'))
    assert.notEqual(next.message?.publicTextSources?.segments[0]?.partId, old.message?.publicTextSources?.segments[0]?.partId)
  } finally { await f.close() }
})

it('seal transaction rejects recovery call/body tampering instead of installing a false native history', async () => {
  const f = await fixture([{ answer: known, intermediate: true }, { business: true }], 'tamper-call')
  try {
    const state = await f.run(); assert.equal(state.run.status, 'failed'); assert.equal(state.message, null); assert.equal(f.effects, 0)
    assert.equal((await f.app.readEvents(f.identity)).events.filter(event => event.kind === 'public.text.sealed').length, 0)
    assert.equal((await f.pool.query("SELECT * FROM lingxios.agent_steps WHERE kind='runtime.answer_segment'")).rows.length, 0)
  } finally { await f.close() }
})

it('compacted native history cannot admit a repeated sealed call ID or poison durable recovery', async () => {
  const f = await fixture([{ answer: known, intermediate: true, callId: 'same-native-id' },
    { answer: 'Unaccepted duplicate body.', intermediate: true, callId: 'same-native-id' }, { answer: null }], 'compacted-duplicate', 8, 'Gather collects items. Check reviews them. Explain only these supplied facts.')
  try {
    await f.run(); assert.equal(f.calls, 1, 'first attempt stops after persisting compacted history')
    const state = await f.restart(); const diagnostics = (await f.app.readEvents(f.identity)).events.filter(event => ['run.failed', 'model.failed'].includes(event.kind)).map(event => ({ kind: event.kind, data: event.data }))
    assert.equal(state.run.status, 'succeeded', JSON.stringify({ calls: f.calls, effects: f.effects, diagnostics })); assert.equal(state.message?.body, known.trim())
    assert.deepEqual([f.calls, f.effects], [3, 0])
    assert.equal(JSON.stringify(f.requests[1]).includes('same-native-id'), false, 'fixture actually removed native history while preserving sealed recovery')
    const events = (await f.app.readEvents(f.identity)).events
    assert.equal(events.filter(event => event.kind === 'public.text.sealed').length, 1, 'the duplicate must be rejected before durable sealing')
    assert.equal((await f.pool.query("SELECT * FROM lingxios.agent_steps WHERE kind='runtime.answer_segment'")).rows.length, 1)
    assert.equal(state.message?.publicTextSources?.segments.length, 1)
  } finally { await f.close() }
})

it('custom native-v1 driver cannot replace the required output binding with unbound streamed answer text', async () => {
  const f = await fixture([{ answer: 'Unbound answer.' }, { answer: 'Unbound answer.' }, { answer: 'Unbound answer.' }], 'missing-binding', 3, 'Answer using only the supplied word: known.')
  try {
    const state = await f.run(); assert.equal(state.run.status, 'failed'); assert.equal(state.message, null)
    assert.equal(f.effects, 0); assert.equal(f.calls, 3); assert.equal(f.strippedBindings, 3, 'every response actually passed through the custom-driver fault')
    const events = (await f.app.readEvents(f.identity)).events
    assert.equal(events.filter(event => event.kind === 'public.text.sealed').length, 0)
    assert.equal(events.filter(event => event.kind === 'tool.started').length, 0)
  } finally { await f.close() }
})
