import assert from 'node:assert/strict'
import {it} from 'node:test'
import {memoryFixture,content,identity,scope} from './memory-fixture.js'
import {memorySynthesisProcessor} from '../src/memory/processor.js'
import {executeMemorySynthesis,type MemoryBatch} from '../src/memory/synthesis.js'
import {withTransaction} from '../src/control-plane/pg-store.js'
import type {WorkProcessorContext} from '../src/runtime/runtime.js'
import type {WorkItem} from '../src/protocol/types.js'

it('keeps protected records available for coverage while excluding them from writable model input',async()=>{
 const f=await memoryFixture()
 try{
  await f.api.apply(identity,{scope,sourceRef:'explicit-source',idempotencyKey:'explicit-profile',
   changes:[{action:'create',content:content('SYNTHETIC_EXPLICIT_FORMAT','format.md')}]})
  const before=(await f.api.list(identity,scope)).items[0]!
  const source=await f.source({text:'我每周六上午在图书馆做统计实验。'})
  const {job}=await f.reflection();assert.ok(job)
  let calls=0
  const context={signal:new AbortController().signal,emit:async()=>{},host:{
   executeAction:async(_work:WorkItem,action:{action:string;args:Record<string,unknown>})=>({ok:true,executionState:'succeeded',
    value:await withTransaction(f.pool,db=>executeMemorySynthesis(db,job,action.action.split('.')[1]!,action.args,f.options))}),
  },model:{structured:async(request:{input:MemoryBatch&{protectedMemories:MemoryBatch['currentMemories']};instructions:string})=>{
   calls++;assert.ok(calls<=2)
   assert.ok(request.input.currentMemories.every(doc=>doc.origin!=='explicit'&&!doc.locked),'writable model input cannot contain protected records')
   assert.equal(request.input.protectedMemories.length,1)
   assert.equal(request.input.protectedMemories[0]!.id,before.id)
   assert.equal(request.input.protectedMemories[0]!.version,before.version)
   assert.equal(request.input.protectedMemories[0]!.body,'SYNTHETIC_EXPLICIT_FORMAT')
   if(calls===1)return {value:{changes:[{sourceRunIds:[source.work.id],change:{action:'create',content:content('周六上午在图书馆做统计实验','routine.md')}}],conflicts:[]}}
   assert.match(request.instructions,/protectedMemories/)
   return {value:{approved:true,complete:true,confidence:1}}
  }}} as unknown as WorkProcessorContext
  await memorySynthesisProcessor.process(job,context)
  const after=await f.api.read(identity,scope,before.id)
  assert.equal(after!.version,before.version);assert.equal(after!.body,'SYNTHETIC_EXPLICIT_FORMAT')
  assert.equal((await f.api.list(identity,scope)).items.length,2)
  assert.equal((await f.pool.query('SELECT status FROM lingxios.agent_memory_evidence')).rows[0]!['status'],'processed')
 }finally{await f.close()}
})

it('repairs one malformed review within the existing page allowance and still requires an independent verdict',async()=>{
 const f=await memoryFixture()
 try{
  await f.source({text:'我每周六上午在图书馆做统计实验。'})
  const {job}=await f.reflection();assert.ok(job)
  let calls=0,applied=0
  const events:Array<{kind:string;data:unknown}>=[]
  const context={signal:new AbortController().signal,emit:async(event:{kind:string;data:unknown})=>{events.push(event)},host:{
   executeAction:async(_work:WorkItem,action:{action:string;args:Record<string,unknown>})=>{
    if(action.action.endsWith('.apply'))applied++
    return {ok:true,executionState:'succeeded',value:await withTransaction(f.pool,db=>executeMemorySynthesis(db,job,action.action.split('.')[1]!,action.args,f.options))}
   },
  },model:{structured:async(request:{instructions:string})=>{
   calls++;assert.ok(calls<=3)
   if(calls===1)return {value:{changes:[],conflicts:[]}}
   assert.match(request.instructions,/Independently audit/)
   // A well-formed negative second verdict must reject, not bless an empty extraction.
   return {value:calls===2?{approved:false,confidence:1,feedback:'SYNTHETIC_PRIVATE_REVIEW'}:{approved:false,complete:false,confidence:1}}
  }}} as unknown as WorkProcessorContext
  await memorySynthesisProcessor.process(job,context)
  assert.equal(calls,3);assert.equal(applied,1)
  assert.equal((await f.pool.query('SELECT status FROM lingxios.agent_memory_evidence')).rows[0]!['status'],'rejected')
  const failures=events.filter(event=>event.kind==='memory.synthesis.validation')
  assert.deepEqual(failures.map(event=>event.data),[{phase:'verification',reason:'review_shape',invalidFields:['complete']}])
  assert.doesNotMatch(JSON.stringify(events),/SYNTHETIC_PRIVATE_REVIEW/)
  assert.equal((await f.api.list(identity,scope)).items.length,0)
 }finally{await f.close()}
})
