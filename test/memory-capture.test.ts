import assert from 'node:assert/strict'
import { it } from 'node:test'
import { memoryFixture, scope } from './memory-fixture.js'
import { drainMemoryCapture } from '../src/memory/capture.js'
import { forgetMemoryScope } from '../src/memory/forget.js'
import { withTransaction, type SqlPool } from '../src/control-plane/pg-store.js'
import { createLingxiOS } from '../src/app/index.js'
import { createLogger } from '../src/logging.js'

it('durably captures only filtered committed sources, runs hooks without locks, and fences forgetting and cancellation', async () => {
  let release!: () => void, entered!: () => void
  let gate = Promise.resolve(), ready = Promise.resolve()
  let transaction = false, hookCalls = 0
  const f = await memoryFixture({ writePolicy: async () => {
    hookCalls++
    assert.equal(transaction, false, 'privacy policy must not hold commit or memory locks')
    entered?.(); await gate
    return { action: 'redact', body: 'Filtered.' }
  } })
  const pool: SqlPool = { query: f.pool.query, connect: async () => ({ release() {}, query: async (sql, params) => {
    if (sql.startsWith('BEGIN')) transaction = true
    try { return await f.pool.query(sql, params) }
    finally { if (/^(COMMIT|ROLLBACK)/.test(sql)) transaction = false }
  } }) }
  const enqueue = async (id: string) => {
    const { work, message } = await f.source({ id, capture: false })
    await f.db.query(`INSERT INTO lingxios.agent_results(id,work_id,request_version,fence,home_epoch,message)
      VALUES($1,$2,1,1,1,$3)`, [id, work.id, JSON.stringify(message)])
    await f.db.query('UPDATE lingxios.agent_work_items SET result_id=$1 WHERE id=$1', [id])
    await f.db.query('INSERT INTO lingxios.agent_memory_capture(result_id) VALUES($1)', [id])
  }
  const pause = () => {
    gate = new Promise(resolve => { release = resolve })
    ready = new Promise(resolve => { entered = resolve })
  }
  try {
    await enqueue('committed')
    pause()
    const capture = drainMemoryCapture(pool, f.options)
    await ready
    assert.equal((await f.db.query('SELECT input_text FROM lingxios.agent_memory_evidence')).rows.length, 0)
    const queued = (await f.db.query<Record<string, unknown>>('SELECT * FROM lingxios.agent_memory_capture')).rows[0]!
    assert.equal(queued['result_id'], 'committed')
    assert.ok(!('input_text' in queued) && !('assistant_text' in queued))
    // Another transaction remains available while an extension is stalled.
    await withTransaction(pool, db => db.query('SELECT 1'))
    release(); await capture
    assert.deepEqual((await f.db.query('SELECT input_text,assistant_text FROM lingxios.agent_memory_evidence')).rows,
      [{ input_text: 'Filtered.', assistant_text: 'Filtered.' }])
    const calls = hookCalls
    await drainMemoryCapture(pool, f.options)
    assert.equal(hookCalls, calls)
    for (const id of ['forgotten', 'cancelled']) {
      await enqueue(id); pause()
      const pending = drainMemoryCapture(pool, f.options)
      await ready
      if (id === 'forgotten') await withTransaction(pool, db => forgetMemoryScope(db, scope))
      else await f.db.query("UPDATE lingxios.agent_work_items SET cancel_requested_at=NOW() WHERE id=$1", [id])
      release(); await pending
      assert.equal((await f.db.query('SELECT 1 FROM lingxios.agent_memory_evidence WHERE source_run_id=$1', [id])).rows.length, 0)
    }
  } finally { release?.(); await f.close() }
})

// Exercise the real app scheduler, durable capture queue, policy hook and JSON
// logger together: an extension can embed private source text in its exception.
it('background capture retries without leaking policy exception text to the actual logger sink', async () => {
  const sentinel='PRIVATE_CAPTURE_SENTINEL_216',lines:string[]=[]
  let calls=0
  const f=await memoryFixture({writePolicy:()=>{calls++;throw new Error(sentinel)}})
  const {work,message}=await f.source({id:'private-capture-error',capture:false})
  await f.db.query(`INSERT INTO lingxios.agent_results(id,work_id,request_version,fence,home_epoch,message)
    VALUES($1,$1,1,1,1,$2)`,[work.id,JSON.stringify(message)])
  await f.db.query('UPDATE lingxios.agent_work_items SET result_id=$1 WHERE id=$1',[work.id])
  await f.db.query('INSERT INTO lingxios.agent_memory_capture(result_id) VALUES($1)',[work.id])
  const app=await createLingxiOS({database:f.pool,memory:f.options,performance:{notifications:false},
    background:{minPollMs:10,maxPollMs:40,sweepIntervalMs:100},logger:createLogger({level:'debug',sink:line=>lines.push(line)})})
  try {
    const deadline=Date.now()+5000
    while(!lines.some(line=>line.includes('Background operation failed')) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10))
    assert.ok(calls>0,'the actual capture hook ran')
    assert.ok(lines.some(line=>line.includes('Background operation failed')),'the scheduler failure reached the actual JSON sink')
    assert.ok(!lines.join('\n').includes(sentinel),'neither message nor serialized stack includes the private exception')
    const row=(await f.db.query<{attempts:number;completed_at:unknown;claim_token:unknown}>('SELECT attempts,completed_at,claim_token FROM lingxios.agent_memory_capture')).rows[0]!
    assert.equal(row.attempts,1);assert.equal(row.completed_at,null);assert.equal(row.claim_token,null)
    assert.equal((await f.db.query('SELECT 1 FROM lingxios.agent_memory_evidence')).rows.length,0)
  } finally {await app.stop();await f.close()}
})
