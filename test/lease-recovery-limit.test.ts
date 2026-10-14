import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { it } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { PgWorkStore, type SqlPool } from '../src/control-plane/pg-store.js'

// Failure modes: crash loops, stale writers, blocked next turns, and normal yields mistaken for crashes.
it('Postgres bounds consecutive abandoned leases while preserving intentional yields', async () => {
  const db = new PGlite()
  const pool: SqlPool = { query: async (sql, params) => {
    const result = await db.query<Record<string, unknown>>(sql, params)
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
  }, connect: async () => ({ query: pool.query, release() {} }) }
  try {
    await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
    const store = new PgWorkStore(pool)
    const enqueue = (id: string) => store.enqueue({ id, tenantId: 't', agentId: 'a', sessionId: 's',
      kind: 'turn', lane: 'interactive', triggerRef: id, meta: { text: id } })
    const hash = (token: string) => createHash('sha256').update(token).digest('hex')
    await enqueue('stuck')
    let work = (await store.claim('worker'))!
    for (let i = 0; i < 4; i++) {
      await store.requestPreempt(work.id)
      assert.equal(await store.yieldWork(work.id, work.fence, hash(work.leaseToken)), true)
      await db.query("UPDATE lingxios.agent_work_items SET available_at=NOW() WHERE id='stuck'")
      work = (await store.claim('worker'))!
      assert.equal(work.id, 'stuck')
    }
    const expire = async () => {
      await db.exec("UPDATE lingxios.agent_work_items SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id='stuck'; UPDATE lingxios.agent_os_session_leases SET expires_at=NOW()-INTERVAL '1 second'")
    }
    for (let i = 0; i < 2; i++) { await expire(); work = (await store.claim('worker'))!; assert.equal(work.id, 'stuck') }
    await enqueue('next')
    await expire()
    assert.equal(await store.claim('worker'), null, 'third abandoned lease must settle instead of restart')
    const row = (await db.query<{ status: string; error: string; goal_outcome: unknown }>("SELECT status,error,goal_outcome FROM lingxios.agent_work_items WHERE id='stuck'")).rows[0]!
    assert.equal(row.status, 'failed')
    assert.match(row.error, /recovery limit/i)
    assert.deepEqual(row.goal_outcome, { status: 'blocked', verification: 'inconclusive', requestVersion: 1, gaps: [row.error] })
    assert.equal(await store.complete(work.id, work.fence, hash(work.leaseToken), { status: 'completed' }), false)
    assert.equal((await store.claim('worker'))?.id, 'next')
    assert.equal((await db.query("SELECT work_id FROM lingxios.agent_os_session_leases WHERE work_id='stuck'")).rows.length, 0)
  } finally { await db.close() }
})
