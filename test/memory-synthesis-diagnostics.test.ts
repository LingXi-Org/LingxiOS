import assert from 'node:assert/strict'
import { it } from 'node:test'
import { memoryFixture,content } from './memory-fixture.js'
import { memorySynthesisProcessor } from '../src/memory/processor.js'
import { executeMemorySynthesis } from '../src/memory/synthesis.js'
import { withTransaction } from '../src/control-plane/pg-store.js'
import type { WorkProcessorContext } from '../src/runtime/runtime.js'
import type { WorkItem } from '../src/protocol/types.js'

it('records only bounded invariant codes for a rejected proposal and repair',async()=>{
  const f=await memoryFixture()
  try {
    await f.source()
    const {job}=await f.reflection();assert.ok(job)
    let calls=0,applied=0
    const events:Array<{kind:string;data:unknown}>=[]
    const context={signal:new AbortController().signal,emit:async(event:{kind:string;data:unknown})=>{events.push(event)},
      host:{executeAction:async(_work:WorkItem,action:{action:string;args:Record<string,unknown>})=>{
        if(action.action.endsWith('.apply'))applied++
        return {ok:true,executionState:'succeeded',value:await withTransaction(f.pool,db=>
          executeMemorySynthesis(db,job,action.action.split('.')[1]!,action.args,f.options))}
      }},model:{structured:async()=>{assert.ok(++calls<=2);return {value:{changes:[{
        sourceRunIds:['SYNTHETIC_PRIVATE_SOURCE'],change:{action:'create',content:content('SYNTHETIC_PRIVATE_BODY')},
      }],conflicts:[]}}}}} as unknown as WorkProcessorContext
    await assert.rejects(memorySynthesisProcessor.process(job,context),/unknown source identity/)
    const failures=events.filter(event=>event.kind==='memory.synthesis.validation')
    assert.deepEqual(failures.map(event=>event.data),[
      {phase:'proposal',reason:'unknown_source'},{phase:'repair',reason:'unknown_source'},
    ])
    assert.doesNotMatch(JSON.stringify(events),/SYNTHETIC_PRIVATE/)
    assert.equal(calls,2);assert.equal(applied,0)
    const row=(await f.pool.query('SELECT status,segment_cursor FROM lingxios.agent_memory_evidence_scopes')).rows[0]!
    assert.equal(row['status'],'pending');assert.equal(row['segment_cursor'],0)
  } finally {await f.close()}
})
