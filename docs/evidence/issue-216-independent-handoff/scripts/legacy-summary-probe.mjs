import assert from 'node:assert/strict'
import {mkdir,rm} from 'node:fs/promises'
import path from 'node:path'
import {setup,countsOnly} from './probe-cli.mjs'
import {randomUUID} from 'node:crypto'
await countsOnly(async()=>{
const cli=await setup(true)
const {memoryFixture,scope}=await cli.importModule('dist/test/memory-fixture.js')
const {createLingxiOS}=await cli.importModule('dist/src/app/index.js')
const {AgentRuntime}=await cli.importModule('dist/src/runtime/runtime.js')
const {summaryItem}=await cli.importModule('dist/src/runtime/compaction.js')
const {maintainStorage}=await cli.importModule('dist/src/app/maintenance.js')
const {legacyMemoryEvidence}=await cli.importModule('dist/src/memory/history.js')
const results=[]
for(const format of ['counts','legacy-arrays','counts-expired']){
 const fixture=await memoryFixture(),marker='SYNTHETIC_'+randomUUID().replaceAll('-','')
 const count=v=>(JSON.stringify(v)??'').split(marker).length-1
 let api
 try{
 api=await createLingxiOS({database:fixture.pool,memory:fixture.options,background:{role:'passive'},performance:{notifications:false}})
 const identity={tenantId:'t',agentId:'a',principalId:'u',sessionId:'legacy-room'}
 const host=api.connectWorker({workerId:'independent',workKinds:['turn']}),inputs=[]
 const model={modelId:'synthetic-local',structured:async()=>{throw Error('unexpected')},compact:async()=>{throw Error('unexpected')},run:async request=>{inputs.push(request.items);return{text:'Done.',output:[],usage:{available:true,inputTokens:1,outputTokens:1}}}}
 await api.enqueue({...identity,id:'seed',text:'Ordinary original request',mode:'read',codeExecution:'disabled',deliveryMode:'text'})
 const work=await host.claimWork()
 await new AgentRuntime(host,model,{execute:async()=>{throw Error('unexpected')}}).runWork(work)
 inputs.length=0
 const summary=JSON.stringify({version:1,fields:{observedResults:marker,decisions:'',remainingWork:'',uncertainties:''},truncated:[]})
 await fixture.db.query('UPDATE lingxios.agent_os_sessions SET summary=$1,history=$2::jsonb',[summary,JSON.stringify([summaryItem(summary)])])
 const data={memorySnapshot:format!=='legacy-arrays'?{counts:{core:1,directory:0,recalled:0,strategies:0}}:{status:'available',core:[{body:marker}],directory:[],recalled:[],strategies:[]}}
 await fixture.db.query(`INSERT INTO lingxios.agent_run_events(run_id,seq,tenant_id,agent_id,kind,stage,visibility,data) VALUES($1,100,'t','a','model.started','started','internal',$2::jsonb)`,[work.id,JSON.stringify(data)])
 let expiredEvents=0
 if(format==='counts-expired'){
  await fixture.db.query("UPDATE lingxios.agent_run_events SET expires_at=NOW()-INTERVAL '1 day' WHERE run_id=$1 AND seq=100",[work.id])
  const emptyHomes=path.join(cli.outputDir,'empty-homes')
  await mkdir(emptyHomes,{mode:0o700})
  try{expiredEvents=(await maintainStorage(fixture.pool,emptyHomes)).expiredEvents}
  finally{await rm(emptyHomes,{recursive:true,force:true})}
  assert.equal(expiredEvents,1)
 }
 const evidence=await legacyMemoryEvidence(fixture.pool,work)
  const before=JSON.stringify((await fixture.db.query('SELECT history,summary FROM lingxios.agent_os_sessions')).rows)
  await api.memory.forget(identity,scope)
  assert.equal(before,JSON.stringify((await fixture.db.query('SELECT history,summary FROM lingxios.agent_os_sessions')).rows))
  await api.enqueue({...identity,id:'after-forget',text:'Reply Done.',mode:'read',codeExecution:'disabled',deliveryMode:'text'})
  const next=await host.claimWork()
  assert.equal(next.id,'after-forget')
  await new AgentRuntime(host,model,{execute:async()=>{throw Error('unexpected')}}).runWork(next)
  const status=(await fixture.db.query('SELECT status FROM lingxios.agent_work_items WHERE id=$1',[next.id])).rows[0].status
  const actionCount=(await fixture.db.query("SELECT count(*)::int AS n FROM lingxios.agent_action_intents WHERE intent->'action'->>'action' LIKE 'memory.%'")).rows[0].n
  const memoryCount=(await fixture.db.query('SELECT count(*)::int AS n FROM lingxios.agent_memories')).rows[0].n
  assert.equal(status,'succeeded');assert.equal(actionCount,0);assert.equal(memoryCount,0)
  results.push({format,expiredEvents,legacyEvidence:evidence.legacyMemoryInvalidated,memoryActionCount:actionCount,memoryRows:memoryCount,providerStubCalls:inputs.length,modelInputSentinelCount:count(inputs),status,durableSummarySentinelCount:count((await fixture.db.query('SELECT summary FROM lingxios.agent_os_sessions')).rows)})
 }finally{try{await api?.stop()}finally{await fixture.close()}}
}
await cli.writeJson('legacy-core-counts.json',{head:cli.revision,productionRequests:0,liveProviderRequests:0,results})
const expected=cli.expect==='red'?1:0
assert.equal(results[0].modelInputSentinelCount,0)
assert.equal(results[1].modelInputSentinelCount,expected)
assert.equal(results[2].modelInputSentinelCount,expected)
console.log(JSON.stringify({expectation:cli.expect,countsControl:results[0].modelInputSentinelCount,legacyArrayLeak:results[1].modelInputSentinelCount,expiredTraceLeak:results[2].modelInputSentinelCount,reproduced:true}))
})
