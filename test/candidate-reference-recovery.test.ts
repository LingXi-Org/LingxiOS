import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS, skillIndex } from '../src/index.js'
import { createWorker } from '../src/worker/index.js'
import { OpenAIChatDriver } from '../src/model/openai.js'
import { nullLogger } from '../src/logging.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import type { AssistantMessage, HostActionResult } from '../src/protocol/types.js'
import { consumeRunEvent, consumeRunState, createRunView, publicAnswerSegments } from '../src/ui/index.js'

type WireRequest = { stream: boolean; messages: Array<{ role: string; content?: unknown }>; tools: Array<{ function: { name: string } }> }
const append = { kind: 'append', supersedes: [] as string[] }
const satisfied = { status: 'satisfied', gaps: [] }
const output = (answer: string | null, outcome: unknown = satisfied, operation = append) => ({ operation, answer, outcome })
let nextCall = 0
const call = (name: string, value: unknown, index = 0) => ({ index, id: `synthetic-${++nextCall}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(value) } })
const frame = (toolCalls: unknown, finish: string | null = 'tool_calls') => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls }, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\n`
const wire = (calls: unknown[]) => new Response(frame(calls) + 'data: [DONE]\n\n')

async function database() {
  const db = new PGlite()
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  let tail = Promise.resolve()
  const acquire = async () => { let release!: () => void; const previous = tail; tail = new Promise<void>(resolve => { release = resolve }); await previous; return release }
  const query: SqlPool['query'] = async (sql, values) => { const result = await db.query<Record<string, unknown>>(sql, values); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length } }
  const pool: SqlPool = { async query(sql, values) { const release = await acquire(); try { return await query(sql, values) } finally { release() } },
    async connect() { return { query, release: await acquire() } } }
  return { db, pool }
}
const identity = { runId: 'candidate-reference-run', tenantId: 'tenant', principalId: 'human', agentId: 'agent', sessionId: 'room' }

it('real native-v2 Worker replaces a durably failed candidate without rewriting its sealed prefix', { timeout: 30_000 }, async () => {
  const { db, pool } = await database(), home = await mkdtemp(join(tmpdir(), 'candidate-reference-'))
  const prefix = 'The sealed prefix remains. ', draft = 'FAILED_CANDIDATE_DIFFERENT_EXPLANATION', corrected = 'The corrected tail is delivered.'
  const deliveries: AssistantMessage[] = []
  const app = await createLingxiOS({ database: pool, homesRoot: home, logger: nullLogger,
    background: { role: 'active', databaseConcurrency: 1, minPollMs: 10, maxPollMs: 20 }, performance: { notifications: false }, realtime: { allowPublicText: () => true },
    delivery: { onEvent: async () => {}, deliverMessage: async (_work, message) => { deliveries.push(message); return { messageId: 'synthetic-final-delivery' } } } })
  let calls = 0, failedId = '', prefixId = ''
  const model = new OpenAIChatDriver('candidate-reference-fixture', { apiKey: 'synthetic-candidate-only', maxAttempts: 1,
    publicTextProtocol: 'purpose-json-v3', publicTextContinuation: 'typed-message-v1', publicAnswerTool: 'native-v2',
    capabilities: { parallelTools: true, jsonObjectWithTools: false }, fetchImpl: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as WireRequest
      assert.equal(request.stream, true, 'no auxiliary model may be added')
      calls++
      assert.ok(calls <= 3, 'correction cannot start an unrequested fourth generation')
      if (calls === 1) return wire([call('public_answer', output(prefix, null))])
      if (calls === 2) {
        const rows = (await pool.query("SELECT input FROM lingxios.agent_steps WHERE work_id=$1 AND kind='runtime.answer_segment' ORDER BY step_seq", [identity.runId])).rows
        assert.equal(rows.length, 1); prefixId = String((rows[0]!['input'] as Record<string, unknown>)['partId'])
        const args = JSON.stringify(output(draft, { status: 'invalid', gaps: [] })), cut = args.indexOf(',"outcome"')
        // The complete draft reaches the real writer before the invalid outcome.
        return new Response(frame([{ index: 0, id: 'failed-public', type: 'function', function: { name: 'public_answer', arguments: args.slice(0, cut) } }], null)
          + frame([{ index: 0, function: { arguments: args.slice(cut) } }]) + 'data: [DONE]\n\n')
      }
      const failures = (await pool.query("SELECT input,output FROM lingxios.agent_steps WHERE work_id=$1 AND kind='runtime.answer_candidate_failure' ORDER BY step_seq", [identity.runId])).rows
      assert.equal(failures.length, 1)
      const metadata = failures[0]!['input'] as Record<string, unknown>; failedId = String(metadata['partId'])
      assert.notEqual(failedId, prefixId)
      assert.equal(JSON.stringify(failures).includes(draft), false)
      for (const key of ['text', 'bodyHash', 'sealedSeq']) assert.equal(Object.hasOwn(metadata, key), false)
      const operation = { kind: 'replace', supersedes: [failedId] }
      const instructions = request.messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n')
      assert.ok(instructions.includes(JSON.stringify(operation)), 'the next model request explicitly selects the failed candidate')
      assert.equal(instructions.includes(JSON.stringify({ kind: 'replace', supersedes: [prefixId] })), false, 'the unaffected prefix is not the correction target')
      return wire([call('public_answer', output(corrected, satisfied, operation))])
    } })
  const worker = createWorker({ controlPlane: app, model, modelBudget: { maxModelCalls: 3 }, logger: nullLogger,
    kernel: { homesRoot: home }, worker: { id: 'candidate-reference-worker', healthPort: 0 } })
  try {
    await app.enqueue({ id: identity.runId, ...identity, text: 'Explain the supplied prefix and tail.', mode: 'execute', codeExecution: 'disabled', deliveryMode: 'auto' })
    assert.equal(await worker.runNext(), true)
    for (let attempt = 0; attempt < 100 && await app.readDelivery(identity) === 'pending'; attempt++) await setTimeout(10)
    const state = (await app.readRunState(identity))!
    assert.equal(state.run.status, 'succeeded', JSON.stringify(state.run)); assert.equal(calls, 3)
    assert.equal(state.delivery, 'delivered'); assert.equal(state.message?.body, prefix + corrected)
    assert.equal(deliveries.length, 1); assert.equal(deliveries[0]!.body, prefix + corrected)
    const sources = state.message!.publicTextSources!.segments
    assert.equal(sources.length, 2); assert.equal(sources[0]!.partId, prefixId); assert.notEqual(sources[1]!.partId, failedId)
    assert.deepEqual(deliveries[0]!.publicTextSources, state.message!.publicTextSources)
    const events = (await app.readEvents(identity)).events
    assert.ok(events.some(event => event.kind === 'public.text.delta' && event.data['partId'] === failedId && event.data['text'] === draft), 'the failed draft really reached durable public text')
    assert.ok(events.some(event => event.kind === 'public.text.ended' && event.data['partId'] === failedId && event.data['reason'] === 'failed'))
    assert.equal(events.some(event => event.kind === 'public.text.sealed' && event.data['partId'] === failedId), false)
    const correctedOperation = events.find(event => event.kind === 'public.text.operation' && event.data['operation'] === 'replace')!
    assert.deepEqual(correctedOperation.data['supersedes'], [failedId])
    let replay = createRunView(identity.runId)
    for (const event of events) replay = consumeRunEvent(replay, event)
    replay = consumeRunState(replay, state)
    assert.equal(publicAnswerSegments(replay).filter(segment => segment.status === 'accepted').map(segment => segment.text).join(''), prefix + corrected)
    assert.deepEqual(publicAnswerSegments(replay).filter(segment => segment.status === 'accepted').map(segment => segment.partId), sources.map(source => source.partId))
    assert.equal(await worker.runNext(), false); assert.equal(calls, 3); assert.equal(deliveries.length, 1)
  } finally { await worker.stop(); await app.stop(); await db.close(); await rm(home, { recursive: true, force: true }) }
})

it('real Worker repairs an invalid explanation quote with an exact source selector before authoring becomes available', { timeout: 30_000 }, async () => {
  const { db, pool } = await database(), home = await mkdtemp(join(tmpdir(), 'candidate-selector-'))
  const skill = { name: 'diagram', version: '1', description: 'Create the requested diagram.', body: 'Use supplied facts before authoring.', actions: ['documents.save'],
    delivery: { checker: 'product:synthetic-diagram' }, workflow: { explanationBeforeAuthoring: { authoringActions: ['documents.save'] } } }
  const { name, version, hash } = skillIndex(skill), selection = { name, version, hash }
  const results: HostActionResult[] = []
  let calls = 0, effects = 0
  const app = await createLingxiOS({ database: pool, homesRoot: home, logger: nullLogger, background: { role: 'passive' },
    performance: { notifications: false }, realtime: { allowPublicText: () => true }, skills: [skill],
    capabilityResolver: { resolve: async () => [{ name: 'documents' }] },
    delivery: { onEvent: async () => {}, deliverMessage: async () => ({ messageId: 'synthetic-selector-delivery' }) },
    tools: [{ name: 'documents__save', action: 'documents.save', effect: 'idempotent', approval: false, description: 'Save a diagram.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }, parse: () => ({}), authorize: async () => {},
      execute: async () => { effects++; return { ok: true, value: {} } } }],
    // A final partial result still requires the trusted checker to resolve the
    // activated delivery. Pending obligations correctly prevent final commit.
    verifySkillDelivery: async context => context.skillActivations.map(activation => ({ activationId: activation.id, outcome: 'failed' as const, evidence: { authoringExecuted: false } })) })
  const connect = app.connectWorker.bind(app)
  app.connectWorker = options => {
    const host = connect(options), execute = host.executeAction.bind(host)
    host.executeAction = async (...args) => { const result = await execute(...args); if (args[1].action === 'skills.activate') results.push(result); return result }
    return host
  }
  const model = new OpenAIChatDriver('selector-repair-worker', { apiKey: 'synthetic-selector-only', maxAttempts: 1,
    publicTextProtocol: 'purpose-json-v3', publicTextContinuation: 'typed-message-v1', publicAnswerTool: 'native-v2',
    capabilities: { parallelTools: true, jsonObjectWithTools: false }, fetchImpl: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as WireRequest
      assert.equal(request.stream, true); calls++; assert.ok(calls <= 4)
      if (calls === 1) return wire([call('public_answer', output('I will select the supplied explanation. ', null)), call('skills__activate', { ...selection,
        explanation: { explanationQuote: 'A rewritten fragment absent from the request.', authoringQuote: 'then draw', factQuotes: ['Gather collects items.'] } }, 1)])
      if (calls === 2) {
        assert.equal(results.length, 1)
        assert.equal(results[0]!.ok, false); assert.equal(results[0]!.executionState, 'no_effect')
        assert.equal(results[0]!.diagnostics?.category, 'invalid_input'); assert.equal(results[0]!.diagnostics?.causeCode, 'explanation_reference_not_found')
        const snapshot = (await pool.query('SELECT request_snapshot FROM lingxios.agent_request_snapshots WHERE work_id=$1', [identity.runId])).rows[0]!['request_snapshot'] as { sourceRef: string }
        const quote = { sourceRef: snapshot.sourceRef }
        return wire([call('public_answer', output('I will use the exact supplied source. ', null)), call('skills__activate', { ...selection,
          explanation: { explanationQuote: quote, authoringQuote: quote, factQuotes: [quote] } }, 1)])
      }
      assert.equal(results.length, 2); assert.equal(results[1]!.ok, true)
      assert.equal(request.tools.some(tool => tool.function.name === 'documents__save'), calls === 4, 'authoring remains hidden until the selected explanation is sealed')
      return calls === 3 ? wire([call('public_answer', output('Gather collects the items. ', null))])
        : wire([call('public_answer', output('I have not authored a diagram.', { status: 'partial', gaps: ['This fixture does not author a diagram.'] }))])
    } })
  const worker = createWorker({ controlPlane: app, model, modelBudget: { maxModelCalls: 4 }, logger: nullLogger,
    kernel: { homesRoot: home }, worker: { id: 'selector-repair-worker', healthPort: 0 } })
  try {
    await app.enqueue({ id: identity.runId, ...identity, text: 'Explain supplied facts, then draw. Gather collects items.', mode: 'execute', codeExecution: 'disabled', deliveryMode: 'auto' })
    assert.equal(await worker.runNext(), true)
    const state = (await app.readRunState(identity))!
    assert.equal(state.run.status, 'partial', JSON.stringify(state.run)); assert.equal(calls, 4); assert.equal(effects, 0)
    assert.equal(state.run.goalOutcome?.status, 'partial', 'activation and a sealed explanation never imply authoring delivery')
    assert.match(state.message!.body, /I have not authored a diagram\./)
    assert.deepEqual(state.message!.envelope.artifacts, [])
    const segments = (await pool.query("SELECT output FROM lingxios.agent_steps WHERE work_id=$1 AND kind='runtime.answer_segment' ORDER BY step_seq", [identity.runId])).rows
    assert.equal(segments.length, 4)
    assert.equal(typeof JSON.parse(String(segments[2]!['output'])).recovery.explanationStageId, 'string', 'the explanation seal is bound to the activated stage')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM lingxios.agent_skill_activations WHERE work_id=$1', [identity.runId])).rows[0]!['n'], 1)
  } finally { await worker.stop(); await app.stop(); await db.close(); await rm(home, { recursive: true, force: true }) }
})
