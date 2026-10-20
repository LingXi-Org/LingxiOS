import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { it } from 'node:test'
import { withRuntimeOperation } from '../src/app/operation-context.js'
import type { SqlPool } from '../src/index.js'

function fixture() {
  const queries: Array<{ sql: string; params?: unknown[] }> = [], releases: Array<Error | undefined> = []
  let acquisitions = 0
  const pool: SqlPool = { query: async () => { throw new Error('unexpected direct pool query') },
    async connect() { acquisitions++; return { async query(sql, params) {
      queries.push({ sql, ...(params ? { params } : {}) })
      return { rows: sql.includes('FROM pg_settings') ? [
        { name: 'statement_timeout', setting: '75' }, { name: 'client_connection_check_interval', setting: '0' }] : [], rowCount: 0 }
    }, release(error) { releases.push(error) } } } }
  return { pool, queries, releases, get acquisitions() { return acquisitions } }
}
it('rejects cancelled, expired and malformed contexts without acquiring a connection', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort(new Error('cancelled'))
  for (const operation of [{ signal: controller.signal }, { deadlineAt: new Date(0).toISOString() }, { deadlineAt: 'invalid' }]) {
    await assert.rejects(withRuntimeOperation(f.pool, operation, async db => db.query('SELECT 1')))
  }
  assert.equal(f.acquisitions, 0)
})
it('preserves stricter server timeouts, restores session settings and releases signal listeners', async () => {
  const f = fixture(), controller = new AbortController()
  await withRuntimeOperation(f.pool, { signal: controller.signal, deadlineAt: new Date(Date.now() + 1000).toISOString() },
    async db => { await db.query('SELECT 1'); await db.query('SELECT 2') })
  assert.equal(f.acquisitions, 1)
  const limits = f.queries.filter(query => query.sql === "SELECT set_config('statement_timeout',$1,false)")
  assert.deepEqual(limits.map(query => query.params), [['75'], ['75']])
  assert.deepEqual(f.queries.at(-1)?.params, ['75', '0'])
  assert.deepEqual(f.releases, [undefined])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
it('rejects a lost commit acknowledgement, discards the connection and never pretends rollback proved no write', async () => {
  const f = fixture(), controller = new AbortController()
  let commitEntered!: () => void
  const entered = new Promise<void>(resolve => { commitEntered = resolve })
  const connecting = f.pool.connect
  f.pool.connect = async () => {
    const client = await connecting()
    return { ...client, query: async (sql, params) => {
      if (sql === 'COMMIT') { commitEntered(); return new Promise(() => {}) }
      return client.query(sql, params)
    } }
  }
  const operation = withRuntimeOperation(f.pool, { signal: controller.signal }, async db => {
    const client = await db.connect()
    try { await client.query('BEGIN'); await client.query('INSERT INTO example VALUES(1)'); await client.query('COMMIT') }
    finally { client.release() }
  })
  await entered; controller.abort(new Error('commit acknowledgement lost'))
  await assert.rejects(operation, /commit acknowledgement lost/)
  assert.equal(f.releases.length, 1)
  assert.ok(f.releases[0] instanceof Error)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
