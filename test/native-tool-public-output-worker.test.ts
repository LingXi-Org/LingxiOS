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
import { nullLogger } from '../src/logging.js'

// The native worker fixture follows public-purpose-worker/react-segments-runtime:
// actual PGlite stores, authorization, public event persistence and delivery seal.
for (const scenario of ['valid', 'bad-schema', 'truncated', 'typed-conflict', 'second-call', 'cancelled', 'denied', 'unknown-effect'] as const) {
  it(`native envelope Worker ${scenario}: early provisional output precedes complete args and atomic dispatch`, { timeout: 20_000 }, async () => {
    const db = new PGlite(), home = await mkdtemp(join(tmpdir(), 'native-envelope-worker-'))
    await db.exec(await readFile(join(process.cwd(), 'db/schema.sql'), 'utf8'))
    let tail = Promise.resolve()
    const acquire = async () => { let release!: () => void; const prior = tail; tail = new Promise<void>(resolve => { release = resolve }); await prior; return release }
    const query: SqlPool['query'] = async (sql, params) => { const result = await db.query<Record<string, unknown>>(sql, params); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length } }
    const pool: SqlPool = { async query(sql, params) { const release = await acquire(); try { return await query(sql, params) } finally { release() } },
      async connect() { return { query, release: await acquire() } } }
    const identity = { runId: `envelope-${scenario}`, tenantId: 'tenant', principalId: 'human', agentId: 'agent', sessionId: 'room' }
    let calls = 0, effects = 0, authorized = 0, argsComplete = false, durableBeforeArgs = false, unknownReplayed = false
    const correctionPayloads: Array<{ correction: string | undefined; system: string }> = []
    let release!: () => void
    const published = new Promise<void>(resolve => { release = resolve })
    const answer = 'Known 2 + 3 = 5. '
    const rawArgs = '{ "value" : 2 }'
    const app = await createLingxiOS({ database: pool, homesRoot: home, logger: nullLogger,
      realtime: { allowPublicText: () => true }, tools: [{ name: 'probe__read', action: 'probe.read', effect: scenario === 'unknown-effect' ? 'uncertain' : 'read', approval: false,
        description: 'Read a synthetic number.', parameters: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false },
        parse: args => args as Record<string, unknown>, authorize: async () => { authorized++; if (scenario === 'denied') throw new Error('synthetic denied') },
        execute: async (context, args) => {
          effects++; assert.deepEqual(args, { value: 2 }); assert.deepEqual(context.action.args, { value: 2 })
          const seals = await context.database.query("SELECT 1 FROM lingxios.agent_run_events WHERE run_id=$1 AND kind='public.text.sealed'", [identity.runId])
          assert.equal(seals.rows.length, 1, 'business dispatch follows the validated source seal')
          if (scenario === 'unknown-effect') throw Object.assign(new Error('Synthetic acknowledgement lost'), { code: 'ECONNRESET' })
          return { ok: true, value: { value: 2 } }
        },
      }] })
    if (scenario === 'unknown-effect') {
      const connect = app.connectWorker.bind(app)
      app.connectWorker = options => {
        const host = connect(options), execute = host.executeAction.bind(host)
        host.executeAction = async (work, action, signal) => {
          const result = await execute(work, action, signal)
          if (action.action === 'probe.read') {
            assert.equal(result.executionState, 'unknown')
            assert.deepEqual(await execute(work, action, signal), result, 'same identity recovery returns the durable unknown receipt')
            assert.equal(effects, 1, 'receipt recovery must not redispatch an uncertain effect')
            unknownReplayed = true
          }
          return result
        }
        return host
      }
    }
    const operation = { kind: 'append', supersedes: [] }
    const frame = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`
    const ending = 'data: {"choices":[],"usage":{"prompt_tokens":17,"completion_tokens":9}}\n\ndata: [DONE]\n\n'
    const model = new OpenAIChatDriver('envelope-worker', { apiKey: 'synthetic', maxAttempts: 1,
      publicTextProtocol: 'purpose-json-v3', nativeToolPublicOutput: 'envelope-v1', capabilities: { jsonObjectWithTools: false, parallelTools: false },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)); assert.equal(body.stream, true, 'no auxiliary judge')
        calls++
        if (calls > 1) {
          if (['truncated', 'typed-conflict', 'second-call'].includes(scenario)) {
            const correction = body.messages.find((message: { role: string; content?: string }) => message.role === 'user' && message.content?.startsWith('Protocol correction:'))
            correctionPayloads.push({ correction: correction?.content, system: body.messages[0].content })
          }
          const valid = scenario === 'valid'
          // A denied action can leave a sealed public prefix. Follow the runtime's
          // durable repair intent instead of appending a rewritten full answer.
          const repair = (await pool.query("SELECT input->'operation' AS operation FROM lingxios.agent_steps WHERE work_id=$1 AND request_version=1 AND kind='runtime.answer_correction' ORDER BY step_seq DESC LIMIT 1", [identity.runId])).rows[0]?.['operation']
          return new Response(frame({ content: JSON.stringify({ operation: repair ?? operation, commentary: '', answer: valid ? null : (repair ? answer : '') + 'The synthetic action could not be completed.',
            outcome: { status: valid ? 'satisfied' : 'blocked', gaps: valid ? [] : ['Synthetic action unavailable.'] } }) }, 'stop') + ending)
        }
        const prefix = '{"public_output":{"operation":{"kind":"append","supersedes":[]},"commentary":"","answer":"' + answer
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode((scenario === 'typed-conflict' ? '' : frame({ content: 'Working now.' })) + frame({ tool_calls: [{ index: 0, id: 'original-call', type: 'function', function: { name: 'probe__read', arguments: prefix } }] })))
        }, async pull(controller) {
          await published
          argsComplete = true
          const suffix = '","outcome":null},"arguments":' + (scenario === 'bad-schema' ? '{"value":"invalid"}' : rawArgs) + '}'
          const delta = { tool_calls: [{ index: 0, function: { arguments: scenario === 'truncated' ? suffix.slice(0, -2) : suffix } }] }
          const conflict = scenario === 'typed-conflict' ? frame({ content: JSON.stringify({ operation, commentary: '', answer: 'Conflicting body.', outcome: null }) }) : ''
          const extra = scenario === 'second-call' ? frame({ tool_calls: [{ index: 1, id: 'second-call', function: { name: 'probe__read', arguments: '{"public_output":null,"arguments":{"value":2}}' } }] }) : ''
          controller.enqueue(new TextEncoder().encode(frame(delta) + conflict + extra + frame({}, 'tool_calls') + ending))
          controller.close()
        } }))
      } })
    model.singleAttempt = () => model
    const run = model.run.bind(model)
    model.run = request => run({ ...request, onTextDelta: async (text, metadata) => {
      await request.onTextDelta?.(text, metadata)
      if (text === answer) {
        const events = await app.readEvents(identity)
        durableBeforeArgs = !argsComplete && events.events.some(event => event.kind === 'public.text.delta' && event.data['text'] === answer)
        assert.equal(effects, 0)
        assert.equal(events.events.filter(event => event.kind === 'public.text.sealed').length, 0)
        if (scenario === 'cancelled') await app.cancel(identity)
        release()
      }
    } })
    const worker = createWorker({ controlPlane: app, model, logger: nullLogger, kernel: { homesRoot: home }, worker: { id: 'envelope-worker', healthPort: 0 } })
    try {
      await app.enqueue({ id: identity.runId, ...identity, text: 'Explain the known sum 2 + 3 and read the synthetic number.', mode: 'execute', codeExecution: 'disabled', deliveryMode: 'text' })
      await worker.runNext()
      const state = await app.readRunState(identity), events = await app.readEvents(identity)
      for (const payload of correctionPayloads) {
        assert.ok(payload.correction, 'actual runtime recovery carries a bounded correction')
        assert.match(payload.correction, /trusted model driver/)
        assert.doesNotMatch(payload.correction, /Tool-turn assistant content example|"operation":|public_output/)
        assert.match(payload.system, /native tool public output envelope v1/)
      }
      assert.ok(durableBeforeArgs, 'public answer persisted while the answer string and business arguments were unfinished')
      assert.equal(effects, scenario === 'valid' || scenario === 'unknown-effect' ? 1 : 0)
      const first = events.events.find(event => event.kind === 'public.text.delta' && event.data['text'] === answer)!
      const firstSealed = events.events.some(event => event.kind === 'public.text.sealed' && event.data['partId'] === first.data['partId'])
      assert.equal(firstSealed, scenario === 'valid' || scenario === 'denied' || scenario === 'unknown-effect')
      if (scenario === 'valid') {
        assert.equal(calls, 2); assert.ok(authorized > 0)
        assert.equal(state?.run.status, 'succeeded'); assert.equal(state.message?.body, answer.trim())
        assert.equal(state.message?.publicTextSources?.segments.length, 1)
        assert.equal(state.message?.publicTextSources?.bodyHash, createHash('sha256').update(answer.trim()).digest('hex'))
        await worker.runNext(); assert.equal(effects, 1); assert.equal(calls, 2)
      } else if (scenario === 'cancelled') {
        assert.equal(state?.run.status, 'cancelled'); assert.equal(state.message, null)
      } else if (scenario === 'unknown-effect') {
        const ledger = await pool.query("SELECT ledger.result,intent.intent FROM lingxios.agent_action_ledger ledger JOIN lingxios.agent_action_intents intent USING(idempotency_key) WHERE intent.intent->>'workId'=$1", [identity.runId])
        const unknown = ledger.rows.find(row => (row['result'] as Record<string, unknown>)['executionState'] === 'unknown')
        assert.ok(unknown, 'lost acknowledgement must retain an uncertain receipt')
        assert.equal(unknownReplayed, true)
        assert.deepEqual(((unknown['intent'] as Record<string, unknown>)['action'] as Record<string, unknown>)['args'], { value: 2 })
        const before = calls
        await worker.runNext()
        assert.equal(effects, 1, 'unknown side effect cannot be redispatched')
        assert.equal(calls, before, 'completed/blocked work cannot silently resume generation')
      } else {
        assert.equal(calls, 2); assert.equal(state?.run.status, 'blocked')
        if (scenario === 'denied') {
          assert.ok(authorized > 0, 'the permission boundary still rejects the action')
          assert.equal(state.message?.body, answer + 'The synthetic action could not be completed.', 'a full replacement retains the already-known result')
          const operations = events.events.filter(event => event.kind === 'public.text.operation')
          assert.deepEqual(operations.map(event => event.data['operation']), ['append', 'replace'])
          assert.deepEqual(operations[1]?.data['supersedes'], [first.data['partId']])
          assert.equal(state.message?.publicTextSources?.segments.length, 1)
        } else assert.equal(state.message?.body, 'The synthetic action could not be completed.')
      }
      assert.doesNotMatch(JSON.stringify(events), /Working now/)
    } finally { release(); await worker.stop(); await app.stop(); await db.close(); await rm(home, { recursive: true, force: true }) }
  })
}
