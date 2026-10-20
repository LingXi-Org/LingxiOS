import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { it } from 'node:test'
import { memoryFixture, content, identity, scope } from './memory-fixture.js'
import { withTransaction } from '../src/control-plane/pg-store.js'
import { executeMemorySynthesis, type MemoryBatch } from '../src/memory/synthesis.js'
import { scheduleMemoryReflection } from '../src/memory/evidence.js'
import { memorySynthesisProcessor } from '../src/memory/processor.js'
import type { WorkProcessorContext } from '../src/runtime/runtime.js'
import type { WorkItem } from '../src/protocol/types.js'

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

for(const repaired of [false,true]) it(`audits empty extraction coverage and bounds repair (${repaired})`,async()=>{
  const f=await memoryFixture()
  try {
    const source=await f.source({text:'我正在筹备名为星河的数学科普展。'})
    const {job}=await f.reflection();assert.ok(job)
    let calls=0
    const changes=[{sourceRunIds:[source.work.id],change:{action:'create',content:content('星河数学科普展','exhibition.md')}}]
    const context={signal:new AbortController().signal,emit:async()=>{},
      host:{executeAction:async(_work:WorkItem,action:{action:string;args:Record<string,unknown>})=>({
        ok:true,executionState:'succeeded',value:await withTransaction(f.pool,db=>executeMemorySynthesis(db,job,action.action.split('.')[1]!,action.args,f.options)),
      })},model:{structured:async(request:{instructions:string})=>{
        calls++;assert.ok(calls<=4,'only one repair and independent recheck')
        if(calls===1)return {value:{changes:[],conflicts:[]}}
        if(calls===3){assert.match(request.instructions,/Repair/);return {value:{changes:repaired?changes:[],conflicts:[]}}}
        assert.match(request.instructions,/coverage/i)
        return {value:{approved:true,complete:repaired&&calls===4,confidence:1,feedback:'A supported exhibition goal is missing.'}}
      }}} as unknown as WorkProcessorContext
    await memorySynthesisProcessor.process(job,context)
    assert.equal(calls,4)
    assert.equal((await f.pool.query('SELECT status FROM lingxios.agent_memory_evidence')).rows[0]!['status'],repaired?'processed':'rejected')
    assert.equal((await f.api.list(identity,scope)).items.length,repaired?1:0)
  } finally {await f.close()}
})

for(const failure of ['cancelled-repair','missing-coverage-verdict']) it(`leaves ${failure} pending instead of advancing the source`,async()=>{
  const f=await memoryFixture(),abort=new AbortController()
  try {
    await f.source()
    const {job}=await f.reflection();assert.ok(job)
    let calls=0,applied=0
    const context={signal:abort.signal,emit:async()=>{},host:{
      executeAction:async(_work:WorkItem,action:{action:string;args:Record<string,unknown>})=>{
        if(action.action.endsWith('.apply'))applied++
        return {ok:true,executionState:'succeeded',value:await withTransaction(f.pool,db=>
          executeMemorySynthesis(db,job,action.action.split('.')[1]!,action.args,f.options))}
      },
    },model:{structured:async()=>{
      if(++calls===1)return {value:{changes:[],conflicts:[]}}
      if(failure==='missing-coverage-verdict')return {value:{approved:true,confidence:1}}
      if(calls===2)return {value:{approved:true,complete:false,confidence:1}}
      assert.equal(calls,3);abort.abort(new Error('synthetic cancellation'))
      return {value:{changes:[],conflicts:[]}}
    }}} as unknown as WorkProcessorContext
    await assert.rejects(memorySynthesisProcessor.process(job,context),failure==='cancelled-repair'?/synthetic cancellation/:/invalid memory synthesis verification/)
    assert.equal(applied,0)
    const row=(await f.pool.query('SELECT status,segment_cursor FROM lingxios.agent_memory_evidence_scopes')).rows[0]!
    assert.equal(row['status'],'pending');assert.equal(row['segment_cursor'],0)
    assert.equal((await f.api.list(identity,scope)).items.length,0)
  } finally {await f.close()}
})
