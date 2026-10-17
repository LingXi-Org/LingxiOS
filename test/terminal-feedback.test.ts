import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { it } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { PgWorkStore, type SqlPool } from '../src/control-plane/pg-store.js'
import { hashToken } from '../src/control-plane/memory-store.js'
import { readDiagnostics, readOperations, refreshMetrics } from '../src/app/diagnostics.js'
import { MetricsRegistry } from '../src/metrics.js'

async function fixture() {
  const db = new PGlite()
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  const pool: SqlPool = { query: async (sql, params) => {
    const result = await db.query<Record<string, unknown>>(sql, params)
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
  }, connect: async () => ({ query: pool.query, release() {} }) }
  const store = new PgWorkStore(pool)
  const enqueue = (id: string, meta: Record<string, unknown> = {}, kind = 'turn') => store.enqueue({
    id, tenantId: 'tenant', agentId: 'agent', principalId: 'human', sessionId: id, kind, lane: 'interactive', triggerRef: 'human-message',
    meta: { text: 'PRIVATE_ORIGINAL', ...meta },
  })
  return { db, pool, store, enqueue }
}

it('reports terminal delivery independently and excludes superseded feedback from pending gauges', async () => {
  const { db,pool,enqueue } = await fixture()
  try {
    await enqueue('current'); await enqueue('obsolete')
    await db.exec("UPDATE lingxios.agent_work_items SET status='failed'")
    await db.exec(`UPDATE lingxios.agent_work_items SET steer_inputs='[{"id":"new","text":"next","createdAt":"now"}]' WHERE id='obsolete'`)
    const identity = { runId: 'current',tenantId: 'tenant',agentId: 'agent',sessionId: 'current',principalId: 'human' }
    const state = await readDiagnostics(pool,identity) as unknown as { terminal: { delivery: string }; delivery: unknown }
    assert.equal(state.terminal.delivery,'pending'); assert.equal(state.delivery,null)
    const metrics = new MetricsRegistry(); await refreshMetrics(pool,metrics)
    assert.match(metrics.expose(),/agentos_terminal_delivery_pending 1/)
    await db.exec("UPDATE lingxios.agent_terminal_outbox SET failed_at=NOW() WHERE root_work_id='current'")
    const operations = await readOperations(pool) as unknown as { failedTerminalDeliveries: number }
    assert.equal(operations.failedTerminalDeliveries,1)
    await refreshMetrics(pool,metrics)
    assert.match(metrics.expose(),/agentos_terminal_delivery_pending 0/)
    assert.match(metrics.expose(),/agentos_terminal_delivery_failed 1/)
  } finally { await db.close() }
})

it('atomically persists terminal feedback without a result and rejects stale lease or request completion', async () => {
  const { db, store, enqueue } = await fixture()
  try {
    await enqueue('root')
    const work = (await store.claim('worker'))!
    const completion = { status: 'failed' as const, error: 'PRIVATE_ERROR', goalOutcome: {
      status: 'blocked' as const, verification: 'inconclusive' as const, requestVersion: 1, gaps: ['PRIVATE_GAP'],
    } }
    assert.equal(await store.complete(work.id, work.fence + 1, hashToken(work.leaseToken), completion), false)
    await store.addSteer(work.id, 'new human request')
    assert.equal(await store.complete(work.id, work.fence, hashToken(work.leaseToken), completion), false)
    assert.equal((await db.query<Record<string, unknown>>('SELECT * FROM lingxios.agent_terminal_outbox')).rows.length, 0)
    assert.equal(await store.complete(work.id, work.fence, hashToken(work.leaseToken), {
      ...completion, goalOutcome: { ...completion.goalOutcome, requestVersion: 2 },
    }), true)
    const rows = (await db.query<Record<string, unknown>>('SELECT * FROM lingxios.agent_terminal_outbox')).rows
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!['root_work_id'], 'root')
    assert.equal(rows[0]!['request_version'], 2)
    assert.equal(rows[0]!['status'], 'failed')
    assert.equal(rows[0]!['failed_count'], 1)
    assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_/)
    const state = (await db.query<Record<string, unknown>>("SELECT status,result_id FROM lingxios.agent_work_items WHERE id='root'")).rows[0]!
    assert.equal(state['status'], 'failed'); assert.equal(state['result_id'], null)
    assert.equal((await db.query<Record<string, unknown>>('SELECT * FROM lingxios.agent_results')).rows.length, 0)
  } finally { await db.close() }
})

it('aggregates one notification per root version while suppressing background and superseded children', async () => {
  const { db, enqueue } = await fixture()
  try {
    await enqueue('root')
    for (const id of ['one', 'two']) await enqueue(id, { rootWorkId: 'root', parentWorkId: 'root', parentRequestVersion: 1, rootRequestVersion: 1 })
    await db.exec("UPDATE lingxios.agent_work_items SET status='failed' WHERE id IN ('one','two')")
    const before = (await db.query<Record<string, unknown>>('SELECT * FROM lingxios.agent_terminal_outbox')).rows
    assert.equal(before.length, 1)
    assert.equal(before[0]!['failed_count'], 2)
    await db.exec("UPDATE lingxios.agent_work_items SET status='failed' WHERE id='one'")
    assert.equal((await db.query<Record<string, unknown>>('SELECT failed_count FROM lingxios.agent_terminal_outbox')).rows[0]!['failed_count'], 2)
    await enqueue('memory', {}, 'memory_synthesis')
    await db.exec("UPDATE lingxios.agent_work_items SET status='failed' WHERE id='memory'")
    await db.exec(`UPDATE lingxios.agent_work_items SET steer_inputs='[{"id":"steer","text":"new","createdAt":"now"}]' WHERE id='root'`)
    await enqueue('stale', { rootWorkId: 'root', parentWorkId: 'root', parentRequestVersion: 1, rootRequestVersion: 1 })
    await db.exec("UPDATE lingxios.agent_work_items SET status='cancelled' WHERE id='stale'")
    const after = (await db.query<Record<string, unknown>>('SELECT * FROM lingxios.agent_terminal_outbox')).rows
    assert.deepEqual(after, before)
    await db.exec("UPDATE lingxios.agent_work_items SET status='cancelled' WHERE id='root'")
    const current = (await db.query<Record<string, unknown>>('SELECT * FROM lingxios.agent_terminal_outbox ORDER BY request_version')).rows
    assert.equal(current.length, 2)
    assert.equal(current[1]!['status'], 'cancelled')
    assert.equal(current[1]!['cancelled_count'], 1)
  } finally { await db.close() }
})

it('reopens durable terminal delivery, reauthorizes each attempt and preserves its stable identity', async () => {
  const { createLingxiOS } = await import('../src/app/index.js')
  const { db, pool, enqueue } = await fixture()
  let app: Awaited<ReturnType<typeof createLingxiOS>> | undefined
  let authorized = false, attempts = 0
  const accepted = new Set<string>(), identities: string[] = [], payloads: string[] = []
  const delivery = {
    onEvent: async () => {}, deliverMessage: async () => { throw new Error('failed work must not deliver a successful result') },
    deliverTerminal: async (work: Omit<import('../src/protocol/types.js').WorkItem, 'leaseToken'>, feedback: import('../src/app/terminal.js').TerminalFeedback) => {
      attempts++
      assert.equal(work.tenantId, 'tenant'); assert.equal(work.principalId, 'human')
      assert.equal(feedback.suppressAgentWake, true)
      identities.push(feedback.id)
      payloads.push(JSON.stringify(feedback))
      if (!authorized) throw new Error('current authorization unavailable')
      accepted.add(feedback.id)
      if (attempts === 2) throw new Error('acceptance acknowledgement lost')
    },
  }
  const options = { database: pool, delivery, performance: { notifications: false }, background: { minPollMs: 10, maxPollMs: 20 } }
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(predicate())
  }
  try {
    await enqueue('reopen')
    await db.exec("UPDATE lingxios.agent_work_items SET status='failed',terminal_reason='context_limit' WHERE id='reopen'")
    app = await createLingxiOS(options)
    await until(() => attempts >= 1)
    await app.stop()
    assert.equal(accepted.size, 0)
    authorized = true
    await db.exec('UPDATE lingxios.agent_terminal_outbox SET available_at=NOW()')
    app = await createLingxiOS(options)
    await until(() => attempts >= 2)
    await app.stop()
    assert.equal(accepted.size, 1)
    // Later aggregation must not change an already accepted payload on a lost-ACK retry.
    await db.exec("UPDATE lingxios.agent_terminal_outbox SET failed_count=failed_count+1,not_started_count=2,not_started_agents=ARRAY['later-agent']")
    await db.exec('UPDATE lingxios.agent_terminal_outbox SET available_at=NOW()')
    app = await createLingxiOS(options)
    await until(() => attempts >= 3)
    for (let i = 0; i < 100; i++) {
      if ((await db.query<Record<string, unknown>>('SELECT delivered_at FROM lingxios.agent_terminal_outbox')).rows[0]?.['delivered_at']) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(accepted.size, 1)
    assert.equal(new Set(identities).size, 1)
    assert.equal(new Set(payloads).size,1)
    const state = await app.readTerminal({ runId: 'reopen', tenantId: 'tenant', agentId: 'agent', sessionId: 'reopen', principalId: 'human' })
    assert.equal(state?.feedback.reason, 'context_limit')
    assert.equal(state?.delivery, 'delivered')
    await app.stop()
    assert.equal((await db.query('SELECT * FROM lingxios.agent_results')).rows.length, 0)
    assert.equal((await db.query('SELECT * FROM lingxios.agent_work_items')).rows.length, 1)
  } finally { await app?.stop(); await db.close() }
})
