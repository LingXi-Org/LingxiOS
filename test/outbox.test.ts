import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { it } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { flushOutbox } from '../src/control-plane/outbox.js'
import { NoEffectError } from '../src/tools/definition.js'

it('stops on explicit authorization denial while dependency failures keep a bounded durable retry', async () => {
  const db = new PGlite()
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url),'utf8'))
  const database = { async query(sql: string,params?: unknown[]) {
    const result = await db.query<Record<string, unknown>>(sql,params)
    return { rows: result.rows,rowCount: result.affectedRows ?? result.rows.length }
  } }
  try {
    for (const id of ['denied','unavailable']) await db.query(`INSERT INTO lingxios.agent_run_events
      (run_id,seq,tenant_id,agent_id,kind,stage,visibility,delivery_work) VALUES($1,1,'t','a','text','delta','user','{}')`,[id])
    await flushOutbox(database,'agent_run_events',async row => {
      if (row['run_id'] === 'denied') throw new NoEffectError('PRIVATE_DENIAL','forbidden')
      throw Object.assign(new Error('PRIVATE_SQL'),{ code: '57014' })
    })
    const rows = (await db.query<Record<string, unknown>>('SELECT run_id,attempts,failed_at,last_error FROM lingxios.agent_run_events ORDER BY run_id')).rows
    assert.ok(rows[0]!['failed_at']); assert.equal(rows[0]!['attempts'],1)
    assert.equal(rows[1]!['failed_at'],null); assert.equal(rows[1]!['attempts'],1)
    assert.doesNotMatch(JSON.stringify(rows),/PRIVATE_/)
  } finally { await db.close() }
})

it('drains ordered events and lets a fresh healthy lane run while an earlier flush is stalled', async () => {
  const db = new PGlite()
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  const database = { async query(sql: string, params?: unknown[]) {
    const result = await db.query<Record<string, unknown>>(sql, params)
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
  } }
  let release!: () => void, began!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { began = resolve })
  const delivered: string[] = []
  const insert = (run: string, seq: number) => db.query(`INSERT INTO lingxios.agent_run_events
    (run_id,seq,tenant_id,agent_id,kind,stage,visibility,delivery_work) VALUES($1,$2,'t','a','text','delta','user','{}')`, [run, seq])
  const deliver = async (row: Record<string, unknown>) => {
    if (row['run_id'] === 'slow') { began(); await blocked }
    delivered.push(`${row['run_id']}:${row['seq']}`)
  }
  try {
    await insert('slow', 1)
    const first = flushOutbox(database, 'agent_run_events', deliver, { concurrency: 2, timeoutMs: 2000 })
    await started
    // Allow the other empty lane to return before admitting more durable work.
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    for (let seq = 1; seq <= 5; seq++) await insert('healthy', seq)
    await flushOutbox(database, 'agent_run_events', deliver, { concurrency: 2 })
    assert.deepEqual(delivered, ['healthy:1', 'healthy:2', 'healthy:3', 'healthy:4', 'healthy:5'])
    release()
    await first
    assert.equal(delivered.at(-1), 'slow:1')
  } finally { release(); await db.close() }
})

it('aborts hung delivery, persists exhaustion, and continues other streams without reordering one stream', async () => {
  const db = new PGlite()
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  const database = { async query(sql: string, params?: unknown[]) {
    const result = await db.query<Record<string, unknown>>(sql, params)
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
  } }
  try {
    for (const [run, seq] of [['hung', 1], ['hung', 2], ['healthy', 1]] as const) await db.query(`INSERT INTO lingxios.agent_run_events
      (run_id,seq,tenant_id,agent_id,kind,stage,visibility,delivery_work) VALUES($1,$2,'t','a','text','delta','user','{}')`, [run, seq])
    const delivered: unknown[] = []
    let cancelled = false
    await flushOutbox(database, 'agent_run_events', async (row, { signal }) => {
      if (row['run_id'] === 'hung') {
        signal.addEventListener('abort', () => { cancelled = true }, { once: true })
        await new Promise<void>(() => {})
      }
      delivered.push([String(row['run_id']), Number(row['seq'])])
    }, { timeoutMs: 20, maxAttempts: 1 })
    assert.equal(cancelled, true)
    assert.deepEqual(delivered, [['healthy', 1]])
    const failed = (await db.query<{ last_error: string; failed_at: unknown }>("SELECT last_error,failed_at FROM lingxios.agent_run_events WHERE run_id='hung' AND seq=1")).rows[0]!
    assert.match(failed.last_error, /deadline exceeded/)
    assert.ok(failed.failed_at)
    await flushOutbox(database, 'agent_run_events', async row => { delivered.push([String(row['run_id']), Number(row['seq'])]) }, { timeoutMs: 20, maxAttempts: 1 })
    assert.deepEqual(delivered, [['healthy', 1]])
    await db.exec("UPDATE lingxios.agent_run_events SET failed_at=NULL,attempts=0,available_at=NOW() WHERE run_id='hung' AND seq=1")
    for (let pass = 0; pass < 2; pass++) await flushOutbox(database, 'agent_run_events', async row => { delivered.push([String(row['run_id']), Number(row['seq'])]) })
    assert.deepEqual(delivered, [['healthy', 1], ['hung', 1], ['hung', 2]])
  } finally { await db.close() }
})
