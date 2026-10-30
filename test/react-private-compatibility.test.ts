/**
 * Failure model: native graph children are genuinely internal work, not public
 * work with a spoofed permission flag. A configured v3 driver must select the
 * same provider's strict v2 before admission and persist the selected identity.
 * Internal output must not create public segments or external message delivery.
 * An old v2 binding parked by a real task.ask cannot silently resume under the
 * new v3/private-v2 selection policy, even though its selected wire is still v2.
 * Synthetic provider only; work and wait/resume state come from native APIs.
 */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS } from '../src/index.js'
import { createWorker } from '../src/worker/index.js'
import { OpenAIChatDriver } from '../src/model/openai.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import type { PublicTextProtocol } from '../src/model/driver.js'
import { sessionKeyOf, type SessionRecord } from '../src/protocol/types.js'
import { snapshotRequest } from '../src/context/request.js'
import { nullLogger } from '../src/logging.js'

async function fixture(ask: boolean, initialProtocol: PublicTextProtocol = 'purpose-json-v3',continuation=false) {
  const db = new PGlite(), home = await mkdtemp(join(tmpdir(), 'react-private-'))
  await db.exec(await readFile('db/schema.sql', 'utf8'))
  let tail = Promise.resolve(), calls = 0, publicAttempts = 0, deliveries = 0
  const acquire = async () => { let release!: () => void; const prior = tail; tail = new Promise<void>(resolve => { release = resolve }); await prior; return release }
  const query: SqlPool['query'] = async (sql, params) => { const result = await db.query<Record<string, unknown>>(sql, params); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length } }
  const pool: SqlPool = {
    async query(sql, params) { const release = await acquire(); try { return await query(sql, params) } finally { release() } },
    async connect() { return { query, release: await acquire() } },
  }
  const app = await createLingxiOS({ database: pool, homesRoot: home, logger: nullLogger,
    realtime: { allowPublicText: work => { if (work.conversation?.internal === true) publicAttempts++; return false } },
    delivery: { onEvent: async () => {}, deliverMessage: async () => { deliveries++; return { messageId: 'unexpected-private-delivery' } } },
  })
  await app.conversations.sync({ tenantId: 'tenant', conversationId: 'room', version: 1, kind: 'group',
    owner: { kind: 'participant', id: 'human' }, defaultAgentId: 'lead', participants: [
      { id: 'human', kind: 'human', capabilities: ['read', 'execute'] },
      { id: 'lead', kind: 'agent', capabilities: ['read', 'execute', 'speak'] },
      { id: 'helper', kind: 'agent', capabilities: ['read', 'execute', 'speak'] },
    ] })
  const parentIdentity = (await app.conversations.ingest({ tenantId: 'tenant', conversationId: 'room', policyVersion: 1,
    messageId: 'native-parent', version: 1, author: { kind: 'human', id: 'human' }, text: 'Delegate a synthetic calculation.' })).runs[0]!
  const host = app.connectWorker({ workerId: 'graph-fixture-parent', workKinds: ['turn'] })
  const parent = (await host.claimWork())!
  assert.equal(parent.conversation?.internal, false)
  await host.reserveModelCall(parent, 'parent-model-reservation', { maxModelCalls: 128, maxTokens: 1_000_000, maxCostMicros: 10_000_000,
    deadlineAt: new Date(Date.now() + 1_800_000).toISOString(), reservedTokens: 120, reservedInputTokens: 100, reservedOutputTokens: 20,
    childAdmission: { inputTokens: 100, outputTokens: 20, executionMs: 1000 } })
  await host.recordModelUsage(parent, 'parent-model-reservation', { inputTokens: 100, outputTokens: 20, costMicros: 0 })
  const context = await host.loadContext(parent)
  const session: SessionRecord = { key: sessionKeyOf(parent), tenantId: parent.tenantId, agentId: parent.agentId, sessionId: parent.sessionId,
    revision: 0, compactionEpoch: 0, history: [], appliedWorkIds: [parent.id], request: snapshotRequest(context) }
  await host.saveSession(parent, session)
  const graph = await app.graphs.enqueue(parentIdentity, { id: 'private-calculation', nodes: [{ id: 'child', agentId: 'helper', text: 'Return the synthetic value 42.' }] })
  const childId = graph.nodes[0]!.workId
  const wait = await app.graphs.waitForChildren(parentIdentity, [childId])
  await host.waitWork(parent, { status: 'delegated', taskRef: String(wait.data!['taskRef']), requestVersion: 1, verification: 'not_run' })
  const childRow = (await pool.query('SELECT tenant_id,agent_id,session_id,principal_id,conversation FROM lingxios.agent_work_items WHERE id=$1', [childId])).rows[0]!
  assert.equal((childRow['conversation'] as { internal: boolean }).internal, true, 'native graph construction owns internal identity')
  const childIdentity = { runId: childId, tenantId: String(childRow['tenant_id']), agentId: String(childRow['agent_id']),
    sessionId: String(childRow['session_id']), principalId: String(childRow['principal_id']) }
  const bodies: Record<string, unknown>[] = []
  const makeDriver = (publicTextProtocol: PublicTextProtocol) => new OpenAIChatDriver('private-fixture-provider', {
    apiKey: 'synthetic-only', publicTextProtocol,...(continuation&&publicTextProtocol==='purpose-json-v3'?{publicTextContinuation:'typed-message-v1' as const}:{}), maxAttempts: 1, capabilities: { jsonObjectWithTools: false },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>; bodies.push(body); calls++
      assert.equal(body['stream'], true, 'private compatibility does not introduce a judge')
      const content = JSON.stringify({ commentary: '', answer: ask ? '' : 'Synthetic value: 42.', outcome: ask ? null : { status: 'satisfied', gaps: [] } })
      const delta = { content, ...(ask ? { tool_calls: [{ index: 0, id: 'ask-fixture', function: { name: 'task__ask', arguments: '{"question":"Which synthetic variant?"}' } }] } : {}) }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: ask ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
    },
  })
  const workers: ReturnType<typeof createWorker>[] = []
  const addWorker = (protocol: PublicTextProtocol) => {
    const driver = makeDriver(protocol)
    const worker = createWorker({ controlPlane: app, model: driver, logger: nullLogger, kernel: { homesRoot: home },
      resources: { model: 1 }, worker: { id: `private-fixture-${workers.length}`, healthPort: 0 } })
    workers.push(worker); return { worker, driver }
  }
  const initial = addWorker(initialProtocol)
  return { app, pool, childId, childIdentity, initial, addWorker, bodies,
    get calls() { return calls }, get publicAttempts() { return publicAttempts }, get deliveries() { return deliveries },
    async close() { for (const worker of workers) await worker.stop(); await app.stop(); await db.close(); await rm(home, { recursive: true, force: true }) },
  }
}

it('native private graph child completes on selected strict v2 with actual binding and no public source leakage', { timeout: 20_000 }, async () => {
  const f = await fixture(false)
  try {
    assert.equal(await f.initial.worker.runNext(), true)
    const state = (await f.app.readRunState(f.childIdentity))!
    assert.equal(state.run.status, 'succeeded', JSON.stringify(state.run))
    assert.equal(state.message?.body, 'Synthetic value: 42.')
    assert.equal(state.message?.publicTextSources, undefined)
    assert.equal(f.calls, 1)
    const binding = (await f.pool.query("SELECT input FROM lingxios.agent_steps WHERE work_id=$1 AND kind='runtime.binding'", [f.childId])).rows[0]!['input'] as Record<string, unknown>
    assert.equal(binding['publicTextProtocol'], 'purpose-json-v2')
    assert.equal(binding['publicTextSelection'], 'public-v3-failed-candidate-v2')
    assert.equal(binding['model'], f.initial.driver.modelId)
    assert.equal(binding['provider'], f.initial.driver.withPublicTextProtocol('purpose-json-v2').configurationFingerprint)
    assert.notEqual(binding['provider'], f.initial.driver.configurationFingerprint)
    assert.match(JSON.stringify(f.bodies[0]!['messages']), /purpose-json-v2/)
    assert.doesNotMatch(JSON.stringify(f.bodies[0]!['messages']), /purpose-json-v3/)
    const events = await f.pool.query("SELECT kind,data FROM lingxios.agent_run_events WHERE run_id=$1 AND kind LIKE 'public.text.%'", [f.childId])
    assert.equal(events.rows.length, 0)
    const sources = await f.pool.query("SELECT step_id FROM lingxios.agent_steps WHERE work_id=$1 AND kind='runtime.answer_segment'", [f.childId])
    assert.equal(sources.rows.length, 0)
    const deliveries = await f.pool.query('SELECT outbox.result_id FROM lingxios.agent_delivery_outbox outbox JOIN lingxios.agent_results result ON result.id=outbox.result_id WHERE result.work_id=$1', [f.childId])
    assert.equal(deliveries.rows.length, 0, 'private results never enter the public delivery queue')
    assert.equal(f.publicAttempts, 0, 'internal work must not request permission to publish')
    assert.equal(f.deliveries, 0)
  } finally { await f.close() }
})

it('native private child with an old v2 binding rejects new selection policy before another provider call', { timeout: 20_000 }, async () => {
  const f = await fixture(true, 'purpose-json-v2')
  try {
    assert.equal(await f.initial.worker.runNext(), true)
    assert.equal((await f.app.readRunState(f.childIdentity))!.run.status, 'waiting')
    const before = (await f.pool.query("SELECT input FROM lingxios.agent_steps WHERE work_id=$1 AND kind='runtime.binding'", [f.childId])).rows[0]!['input']
    assert.equal((before as Record<string, unknown>)['publicTextSelection'], undefined)
    assert.equal((before as Record<string, unknown>)['publicTextProtocol'], 'purpose-json-v2')
    await f.app.continueInput({ ...f.childIdentity, inputId: 'synthetic-reply', requestVersion: 1, text: 'Use the first variant.' })
    const changed = f.addWorker('purpose-json-v3')
    assert.equal(await changed.worker.runNext(), true)
    const state = (await f.app.readRunState(f.childIdentity))!
    assert.equal(state.run.status, 'failed')
    assert.equal(f.calls, 1, 'a changed binding cannot spend another provider call')
    const after = (await f.pool.query("SELECT input FROM lingxios.agent_steps WHERE work_id=$1 AND kind='runtime.binding'", [f.childId])).rows[0]!['input']
    assert.deepEqual(after, before, 'the old binding is never rewritten')
    const events = await f.pool.query("SELECT data FROM lingxios.agent_run_events WHERE run_id=$1 AND kind='run.failed'", [f.childId])
    assert.equal(events.rows.length, 1)
    assert.deepEqual(events.rows[0]!['data'], { error: 'Runtime operation failed' }, 'public errors retain diagnostic redaction')
    assert.equal(state.message, null)
    assert.equal(f.deliveries, 0)
  } finally { await f.close() }
})

it('continuation opt-in selects the unchanged private v2 driver and binding',async()=>{
  const f=await fixture(false,'purpose-json-v3',true)
  try{assert.equal(await f.initial.worker.runNext(),true)
    assert.equal((await f.app.readRunState(f.childIdentity))?.run.status,'succeeded');assert.equal(f.calls,1)
    const binding=(await f.pool.query("SELECT input FROM lingxios.agent_steps WHERE work_id=$1 AND kind='runtime.binding'",[f.childId])).rows[0]!['input'] as Record<string,unknown>
    assert.equal(binding['publicTextContinuation'],undefined)
    assert.equal(binding['provider'],f.initial.driver.withPublicTextProtocol('purpose-json-v2').configurationFingerprint)
    assert.doesNotMatch(JSON.stringify(f.bodies),/typed-message-v1|Message lifecycle capability/)
    const messages=f.bodies[0]!['messages'] as Array<{role:string;content:string}>
    const system=messages.filter(message=>message.role==='system').map(message=>message.content).join('\n')
    assert.match(system,/Public output wire contract \(purpose-json-v2\)/)
    assert.match(system,/With no native tool calls, answer must be nonempty and outcome must be an object with exactly status then gaps/)
    assert.match(system,/status is satisfied only when the current requested result was delivered/)
    assert.match(system,/otherwise use partial or blocked/)
    assert.match(system,/Native authorization, receipts, resources and completion checks remain authoritative/)
    assert.doesNotMatch(system,/purpose-json-v3|operation precedes|"operation":|answer:null|Tool-turn assistant content example/)

    assert.equal(f.publicAttempts,0)
  }finally{await f.close()}
})
