import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { it } from 'node:test'
import { createWorkspaceStore } from '../src/app/workspaces.js'
import { createRealtime, type RealtimeStore } from '../src/app/realtime.js'
import { flushOutbox } from '../src/control-plane/outbox.js'
import { Wakeup } from '../src/control-plane/wakeup.js'
import { drainMemoryCapture } from '../src/memory/capture.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import { createLingxiOS } from '../src/app/index.js'
import { memoryFixture } from './memory-fixture.js'
import { sessionKeyOf } from '../src/protocol/types.js'
import { snapshotRequest } from '../src/context/request.js'

// Operation boundaries/failure cases, declared before expanding the fix:
// workspace: whole page, including list/delete rejection; outbox: acknowledgement
// or failure persistence; memory: one claim, including policy failure/requeue;
// verification: callback plus record validation; recovery: shared promise settlement
// (existing async-audit/recovery tests); LISTEN: acquire+LISTEN or connect/query failure
// (existing wakeup tests); realtime: each store call, stream close/error/cancel and
// each double-wakeup race. Completed operations must be detached from later shutdown.
const row = { id: 'r', tenant_id: 't', agent_id: 'a', session_id: 's', principal_id: 'u', thread_id: null,
  kind: 'turn', lane: 'interactive', fence: 1, status: 'succeeded', request_version: 1, attempts: 0,
  created_at: new Date().toISOString(), available_at: new Date().toISOString(), steer_inputs: [], message: null }
const empty = { rows: [], rowCount: 0 }
const pool: SqlPool = { async query(sql) { return sql.includes('agent_run_events') ? empty : { rows: [row], rowCount: 1 } },
  async connect() { return { query: pool.query, release() {} } } }

for (const fail of [false, true]) it(`detaches finished workspace, outbox and memory operations from shutdown (failure=${fail})`, async () => {
  const roots: AbortController[] = [], observed: AbortSignal[] = []
  const root = () => { const value = new AbortController(); roots.push(value); return value.signal }
  const workspace = createWorkspaceStore(pool, { async put() {}, async get() { return null }, async delete() {},
    async list(_prefix, _cursor, _limit, signal) {
      observed.push(signal)
      if (fail) throw new Error('synthetic list failure')
      return { objects: [] }
    } })
  const page = workspace.maintenance(root())
  if (fail) await assert.rejects(page, /synthetic list failure/)
  else await page
  const outbox = { async query(sql: string) { return sql.includes('WITH candidate') ? { rows: [{ run_id: 'r', seq: 1 }], rowCount: 1 } : empty } }
  await flushOutbox(outbox, 'agent_run_events', async (_row, context) => {
    observed.push(context.signal)
    if (fail) throw new Error('synthetic delivery failure')
  }, { signal: root(), maxRows: 1, concurrency: 1 })
  let claimed = false
  const memory: SqlPool = { async query(sql) {
    if (sql.includes('WITH ready')) { if (claimed) return empty; claimed = true; return { rows: [{ result_id: 'r' }], rowCount: 1 } }
    return sql.startsWith('SELECT') ? { rows: [row], rowCount: 1 } : empty
  }, async connect() { return { query: memory.query, release() {} } } }
  const capture = drainMemoryCapture(memory, { async resolveScopes(_identity, _db, signal) {
    assert.ok(signal); observed.push(signal)
    if (fail) throw new Error('synthetic memory failure')
    return []
  } }, root())
  if (fail) await assert.rejects(capture, /synthetic memory failure/)
  else await capture
  assert.equal(observed.length, 3)
  for (const controller of roots) controller.abort(new Error('later shutdown'))
  assert.deepEqual(observed.map(signal => signal.aborted), [false, false, false])
  for (const controller of roots) assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

for (const fail of [false, true]) it(`detaches completed ephemeral reads and releases SSE subscriptions (failure=${fail})`, async () => {
  const shutdown = new AbortController(), input = new AbortController()
  let observed: AbortSignal | undefined, disposed = 0
  const store: RealtimeStore = { async update() { return 'applied' }, async clear() {},
    async read(_identity, signal) { observed = signal; if (fail) throw new Error('synthetic store failure'); return null },
    async subscribe() { return () => { disposed++ } } }
  const realtime = createRealtime(pool, new Wakeup(), shutdown.signal, { store })
  const response = await realtime.response({ runId: 'r', tenantId: 't', agentId: 'a', sessionId: 's', principalId: 'u' }, { signal: input.signal })
  await response.text()
  assert.ok(observed)
  assert.equal(disposed, 1)
  shutdown.abort(); input.abort()
  assert.equal(observed.aborted, false)
  assert.equal(getEventListeners(shutdown.signal, 'abort').length, 0)
  assert.equal(getEventListeners(input.signal, 'abort').length, 0)
})

it('detaches verification callbacks when they finish before application shutdown', async () => {
  const f = await memoryFixture()
  let observed: AbortSignal | undefined
  const app = await createLingxiOS({ database: f.pool, background: { role: 'passive' }, verifyRun: async context => {
    observed = context.signal
    return [{ checker: 'product:synthetic', status: 'passed', evidence: {} }]
  } })
  try {
    await app.enqueue({ id: 'verification', tenantId: 't', agentId: 'a', sessionId: 's', principalId: 'u', text: 'Synthetic verification' })
    const host = app.connectWorker({ workerId: 'test', workKinds: ['turn'] }), work = (await host.claimWork())!
    await host.saveSession(work, { key: sessionKeyOf(work), tenantId: 't', agentId: 'a', sessionId: 's', revision: 0,
      compactionEpoch: 0, history: [], appliedWorkIds: [work.id], request: snapshotRequest(await host.loadContext(work)) })
    await host.verifyCandidate(work, { body: 'Synthetic response', requestVersion: 1, artifacts: [] })
    assert.ok(observed)
    await app.stop()
    assert.equal(observed.aborted, false)
  } finally { await app.stop(); await f.close() }
})
