import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { it } from 'node:test'
import { memoryFixture, content, identity, scope } from './memory-fixture.js'
import { withTransaction } from '../src/control-plane/pg-store.js'
import { executeMemorySynthesis, type MemoryBatch } from '../src/memory/synthesis.js'
import { scheduleMemoryReflection } from '../src/memory/evidence.js'

for (const mode of ['mixed', 'approved', 'incomplete'] as const) it(`reports ${mode} long-source completeness across separate jobs`, async () => {
  const f = await memoryFixture()
  try {
    const source = await f.source({ text: '普通中文材料。'.repeat(2700) + '末尾偏好：图解。' })
    if (mode === 'incomplete') await f.db.query('UPDATE lingxios.agent_memory_evidence SET source_complete=false')
    let job = (await f.reflection()).job, pages = 0, tail = false
    while (job) {
      assert.ok(++pages <= 10)
      const invoke = (method: string, args: Record<string, unknown>) =>
        withTransaction(f.pool, db => executeMemorySynthesis(db, job!, method, args, f.options))
      const batch = await invoke('load', {}) as MemoryBatch
      if (!batch) break
      tail ||= batch.evidence.some(item => item.userText.includes('末尾偏好'))
      const approved = mode !== 'mixed' || pages !== 2
      const args = { changes: approved ? [] : [{ sourceRunIds: [source.work.id],
        change: { action: 'create', content: content('unverified', 'unverified.md') } }], conflicts: [], approved, confidence: 1 }
      await invoke('apply', args)
      await invoke('apply', args)
      await f.store.complete(job!.id, job!.fence, createHash('sha256').update(job!.leaseToken).digest('hex'), { status: 'completed' })
      job = (await f.reflection()).job
    }
    assert.ok(pages >= 3)
    assert.ok(tail)
    const expected = mode === 'mixed' ? 'rejected' : mode === 'approved' ? 'processed' : 'pending'
    const row = (await f.pool.query('SELECT status FROM lingxios.agent_memory_evidence_scopes')).rows[0]!
    assert.equal(row['status'], expected, 'a successful tail cannot erase rejected or missing source segments')
    assert.equal((await f.pool.query('SELECT status FROM lingxios.agent_memory_evidence')).rows[0]!['status'], expected)
    assert.equal((await f.api.list(identity, scope)).items.length, 0)
    assert.equal((await f.reflection()).job, null, 'terminal review rejection or incomplete capture must not loop')
    const maintenance = (await f.api.doctor(identity,scope)).maintenance!
    assert.equal(maintenance.processedSources,mode === 'approved' ? 1 : 0)
    assert.equal(maintenance.rejectedSources,mode === 'mixed' ? 1 : 0)
    assert.equal(maintenance.incompleteSources,mode === 'incomplete' ? 1 : 0)
    assert.equal(maintenance.retryableSources,0)
  } finally { await f.close() }
})

it('does not hide an unfinished or rejected scope behind a successful scope',async()=>{
  const second={...scope,scopeType:'course',scopeId:'course'}
  const f=await memoryFixture({resolveScopes:async()=>[scope,second]})
  try {
    const source=await f.source({scopes:[scope,second]})
    for(const [index,target] of [scope,second].entries()){
      await scheduleMemoryReflection(f.pool,f.options,{identity,scope:target})
      const job=(await f.store.claim('worker'))!
      const invoke=(method:string,args:Record<string,unknown>)=>withTransaction(f.pool,db=>executeMemorySynthesis(db,job,method,args,f.options))
      await invoke('load',{})
      await invoke('apply',{changes:index ? [{sourceRunIds:[source.work.id],change:{action:'create',content:content('rejected')}}] : [],
        conflicts:[],approved:!index,confidence:1})
      await f.store.complete(job.id,job.fence,createHash('sha256').update(job.leaseToken).digest('hex'),{status:'completed'})
      assert.equal((await f.pool.query('SELECT status FROM lingxios.agent_memory_evidence')).rows[0]!['status'],index?'rejected':'pending')
    }
  } finally {await f.close()}
})
