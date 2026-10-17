import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { it } from 'node:test'
import { BackgroundScheduler, backgroundPool } from '../src/app/background-scheduler.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import { createLingxiOS } from '../src/app/index.js'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { flushOutbox } from '../src/control-plane/outbox.js'

const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

it('backs off empty/error scans, resets on work, and recovers through a periodic sweep', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const abort = new AbortController(), attempts: number[] = [], failures: string[] = []
  let result: boolean | Error = false
  const scheduler = new BackgroundScheduler({ signal: abort.signal, minPollMs: 100, maxPollMs: 800,
    onError: (name) => failures.push(name) })
  scheduler.add('scan', async () => { attempts.push(1); if (result instanceof Error) throw result; return result }, { concurrency: 2 })
  await settle()
  for (const [ms, count] of [[100, 1], [199, 1], [1, 2], [400, 3], [800, 4], [800, 5]] as const) {
    t.mock.timers.tick(ms); await settle(); assert.equal(attempts.length, count)
  }
  result = true
  scheduler.wake('scan'); await settle(); assert.equal(attempts.length, 6)
  t.mock.timers.tick(100); await settle(); assert.equal(attempts.length, 7)
  result = new Error('offline')
  t.mock.timers.tick(100); await settle(); assert.equal(failures.length, 1)
  t.mock.timers.tick(199); await settle(); assert.equal(failures.length, 1)
  t.mock.timers.tick(1); await settle(); assert.equal(failures.length, 2)
  abort.abort(); await scheduler.stop()
  assert.equal(scheduler.pending, 0)
  t.mock.timers.tick(100_000); await settle(); assert.equal(attempts.length, 9)
})

it('coalesces notifications during a scan without losing the follow-up and stops idempotently', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const abort = new AbortController(), blocked = deferred()
  let scans = 0
  const scheduler = new BackgroundScheduler({ signal: abort.signal, minPollMs: 10, maxPollMs: 80 })
  scheduler.add('scan', async () => { scans++; if (scans === 1) await blocked.promise; return false })
  scheduler.wake('scan'); await settle(); assert.equal(scans, 1)
  for (let i = 0; i < 100; i++) scheduler.wake('scan')
  await settle(); assert.equal(scans, 1)
  blocked.resolve(); await settle(); assert.equal(scans, 2)
  const stopping = scheduler.stop(); assert.equal(scheduler.stop(), stopping); await stopping
  scheduler.wake('scan'); t.mock.timers.tick(1000); await settle()
  assert.equal(scans, 2); assert.equal(scheduler.pending, 0)
})

it('keeps free outbox lanes polling while one call is stalled, with bounded overlap', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const abort = new AbortController(), blocked = deferred()
  let calls = 0, active = 0, peak = 0
  const scheduler = new BackgroundScheduler({ signal: abort.signal, minPollMs: 10, maxPollMs: 80 })
  scheduler.add('outbox', async () => {
    const call = ++calls; peak = Math.max(peak, ++active)
    if (call === 1) await blocked.promise
    active--; return call === 2
  }, { concurrency: 2 })
  scheduler.wake('outbox'); await settle(); assert.equal(calls, 1)
  t.mock.timers.tick(10); await settle(); assert.equal(calls, 2)
  t.mock.timers.tick(10); await settle(); assert.equal(calls, 3)
  assert.equal(peak, 2)
  blocked.resolve(); await settle(); await scheduler.stop()
  assert.equal(scheduler.pending, 0)
})

it('caps background connections across jobs, holds transaction permits, and releases once', async () => {
  const abort = new AbortController()
  let held = 0, peak = 0, released = 0
  const raw: SqlPool = { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => {
    peak = Math.max(peak, ++held)
    return { query: raw.query, release: () => { held--; released++ } }
  } }
  const pool = backgroundPool(raw, 2, abort.signal)
  const first = await pool.connect(), second = await pool.connect()
  let thirdAcquired = false
  const third = pool.connect().then(client => { thirdAcquired = true; return client })
  await settle(); assert.equal(thirdAcquired, false)
  await first.query('BEGIN'); await first.query('COMMIT')
  await settle(); assert.equal(thirdAcquired, false)
  first.release(); first.release(); const client = await third
  second.release(); client.release()
  assert.equal(held, 0); assert.equal(peak, 2); assert.equal(released, 3)
})

it('cancels queued and late background acquisitions without leaking permits or clients', async () => {
  const abort = new AbortController(), connecting = deferred()
  let acquired = 0, released = 0
  const raw: SqlPool = { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => {
    acquired++; await connecting.promise
    return { query: raw.query, release: () => { released++ } }
  } }
  const pool = backgroundPool(raw, 1, abort.signal)
  const first = pool.connect(), second = pool.connect()
  await settle(); assert.equal(acquired, 1)
  abort.abort(new Error('stopped'))
  await assert.rejects(first, /stopped/); await assert.rejects(second, /stopped/)
  connecting.resolve(); await settle(); assert.equal(released, 1); assert.equal(acquired, 1)
  await assert.rejects(pool.query('SELECT 1'), /stopped/)
})

it('releases permits after acquisition/query exceptions and aborts active clients once', async () => {
  const abort = new AbortController(), querying = deferred()
  let failConnect = true, released = 0
  const raw: SqlPool = { query: async () => { throw new Error('query failed') }, connect: async () => {
    if (failConnect) { failConnect = false; throw new Error('connect failed') }
    return { query: async (sql) => sql === 'hang' ? querying.promise.then(() => ({ rows: [], rowCount: 0 })) : raw.query(sql), release() { released++ } }
  } }
  const pool = backgroundPool(raw, 1, abort.signal)
  await assert.rejects(pool.connect(), /connect failed/)
  await assert.rejects(pool.query('SELECT 1'), /query failed/)
  const client = await pool.connect(), operation = client.query('hang')
  abort.abort(new Error('stop query'))
  await assert.rejects(operation, /stop query/)
  client.release(); querying.resolve(); await settle()
  assert.equal(released, 2)
})

it('default app listens for notifications and delivers durable rows', async () => {
  const db = new PGlite()
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  const events = new EventEmitter(), listening = deferred(), delivered: string[] = []
  let listenerReleases = 0
  const query: SqlPool['query'] = async (sql, params) => {
    const result = await db.query<Record<string, unknown>>(sql, params)
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
  }
  const pool: SqlPool = { query, connect: async () => ({
    query: async (sql, params) => {
      if (sql.startsWith('LISTEN ')) { listening.resolve(); return { rows: [], rowCount: 0 } }
      return query(sql, params)
    },
    on: events.on.bind(events), removeListener: events.removeListener.bind(events),
    release(error?: Error) { if (error?.message === 'notification listener closed') listenerReleases++ },
  }) }
  const app = await createLingxiOS({ database: pool, delivery: { deliverMessage: async () => {},
    onEvent: async (_work, event) => { delivered.push(event.runId) } } })
  const insert = async (id: string) => { await db.query(`INSERT INTO lingxios.agent_run_events
    (run_id,seq,tenant_id,agent_id,kind,stage,visibility,delivery_work) VALUES($1,1,'t','a','text','delta','user','{}')`, [id]) }
  const eventually = async (predicate: () => boolean) => {
    for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(predicate())
  }
  try {
    await listening.promise
    await insert('notification')
    events.emit('notification', { channel: 'lingxios_outbox' })
    await eventually(() => delivered.includes('notification'))
    await app.stop()
    assert.equal(listenerReleases, 1)
    assert.equal(events.listenerCount('notification'), 0)
  } finally { await app.stop(); await db.close() }
})

it('outbox reports empty, busy and failed scans without holding DB permits during delivery', async () => {
  const db = new PGlite()
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  const shutdown = new AbortController()
  let held = 0
  const raw: SqlPool = { query: async (sql, params) => {
    const result = await db.query<Record<string, unknown>>(sql, params)
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
  }, connect: async () => { held++; return { query: raw.query, release() { held-- } } } }
  const pool = backgroundPool(raw, 1, shutdown.signal)
  try {
    assert.deepEqual(await flushOutbox(pool, 'agent_run_events', async () => {}), { claimed: 0, errors: 0, active: 0 })
    await db.query(`INSERT INTO lingxios.agent_run_events (run_id,seq,tenant_id,agent_id,kind,stage,visibility,delivery_work)
      VALUES('run',1,'t','a','text','delta','user','{}')`)
    const result = await flushOutbox(pool, 'agent_run_events', async () => {
      assert.equal(held, 0)
      await pool.query('SELECT 1')
      throw new Error('transport offline')
    })
    assert.equal(result.claimed, 1); assert.equal(result.errors, 1); assert.equal(result.active, 0)
    const failing = { query: async () => { throw new Error('database offline') } }
    const failed = await flushOutbox(failing, 'agent_run_events', async () => {})
    assert.ok(failed.errors > 0)
  } finally { shutdown.abort(); await db.close() }
})

it('active fallback polling finds rows without notifications and stop cancels an in-flight transport', async () => {
  const db = new PGlite()
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  const started = deferred(), transported = deferred()
  let cancelled = false
  const pool: SqlPool = { query: async (sql, params) => {
    const result = await db.query<Record<string, unknown>>(sql, params)
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
  }, connect: async () => ({ query: pool.query, release() {} }) }
  const app = await createLingxiOS({ database: pool, performance: { notifications: false },
    background: { minPollMs: 10, maxPollMs: 40, sweepIntervalMs: 100 }, delivery: {
      deliverMessage: async () => {}, onEvent: async (_work, _event, context) => {
        assert.ok(context)
        started.resolve(); context.signal.addEventListener('abort', () => { cancelled = true }, { once: true })
        await transported.promise
      },
    } })
  try {
    await new Promise(resolve => setTimeout(resolve, 100))
    await db.query(`INSERT INTO lingxios.agent_run_events (run_id,seq,tenant_id,agent_id,kind,stage,visibility,delivery_work)
      VALUES('fallback',1,'t','a','text','delta','user','{}')`)
    await Promise.race([started.promise, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('fallback scan missed durable row')), 500))])
    await app.stop()
    assert.equal(cancelled, true)
    const pending = (await db.query<{ delivered_at: unknown }>("SELECT delivered_at FROM lingxios.agent_run_events WHERE run_id='fallback'")).rows[0]!
    assert.equal(pending.delivered_at, null)
  } finally { transported.resolve(); await app.stop(); await db.close() }
})

it('passive public apps create no listener or background SQL and keep explicit APIs usable', async t => {
  const db = new PGlite()
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  let connects = 0, queries = 0
  const pool: SqlPool = { query: async (sql, params) => {
    queries++; const result = await db.query<Record<string, unknown>>(sql, params)
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
  }, connect: async () => { connects++; return { query: pool.query, release() {} } } }
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const app = await createLingxiOS({ database: pool, background: { role: 'passive' } })
  try {
    const counts = [connects, queries]
    t.mock.timers.tick(120_000); await settle(); assert.deepEqual([connects, queries], counts)
    await app.enqueue({ tenantId: 't', agentId: 'a', principalId: 'u', sessionId: 's', id: 'passive', text: 'hello' })
    assert.equal((await app.readRunState({ tenantId: 't', agentId: 'a', principalId: 'u', sessionId: 's', runId: 'passive' }))?.run.status, 'queued')
    await app.maintenance()
    const stopping = app.stop(); assert.equal(app.stop(), stopping); await stopping
    const stoppedCounts = [connects, queries]
    t.mock.timers.tick(120_000); await settle(); assert.deepEqual([connects, queries], stoppedCounts)
  } finally { t.mock.timers.reset(); await app.stop(); await db.close() }
})

it('validates background limits before accessing the database', async () => {
  let queries = 0
  const pool: SqlPool = { query: async () => { queries++; return { rows: [], rowCount: 0 } }, connect: async () => { throw new Error('unexpected acquisition') } }
  for (const background of [{ role: 'other' }, { databaseConcurrency: 0 }, { databaseConcurrency: 33 },
    { minPollMs: 0 }, { minPollMs: 200, maxPollMs: 100 }, { sweepIntervalMs: 0 }, { maxPollMs: Infinity }]) {
    await assert.rejects(createLingxiOS({ database: pool, background: background as never }), /background/)
  }
  assert.equal(queries, 0)
})
