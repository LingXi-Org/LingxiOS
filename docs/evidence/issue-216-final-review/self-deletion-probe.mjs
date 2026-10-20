import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
const [root,out]=process.argv.slice(2),load=p=>import(pathToFileURL(root+'/'+p).href)
const {memoryFixture}=await load('dist/test/memory-fixture.js')
const {createLingxiOS}=await load('dist/src/app/index.js')
const {createWorker}=await load('dist/src/worker/factory.js')
const source=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()
const report={source,provider:'scripted local model; actual AgentRuntime/native tools/PGlite',providerRequests:0,productionRequests:0,cases:[],passed:false}
for(const operation of ['forget','apply-delete']){
 const scope={tenantId:'t',scopeType:'user',scopeId:'u',continuity:'principal'}
 const fixture=await memoryFixture({resolveScopes:async()=>[scope],contextBudget:{optionalRecall:true}})
 let api,worker
 const row={operation,passed:false,modelCalls:0,modelInputMarkerCounts:[]};report.cases.push(row)
 try{
  api=await createLingxiOS({database:fixture.pool,memory:fixture.options,background:{role:'passive'},performance:{notifications:false}})
  const identity={tenantId:'t',agentId:'a',principalId:'u',sessionId:'self-'+operation},id='self-'+operation
  const stable=(await api.memory.scopes(identity))[0]
  const docs=(await api.memory.initialize(identity,{scope:stable,idempotencyKey:'seed',sourceRef:'settings',documents:[
   {path:'removed.md',title:'Synthetic selected fact',description:'Synthetic',body:'SYNTHETIC_SELECTED_MEMORY',layer:'core',locked:true},
   {path:'retained.md',title:'Synthetic retained fact',description:'Synthetic',body:'SYNTHETIC_RETAINED_MEMORY',layer:'core',locked:true},
  ]})).documents
  const selected=docs.find(d=>d.path==='removed.md')
  const usage={available:true,inputTokens:20,outputTokens:5}
  const model={modelId:'synthetic-local',compact:async()=>{throw Error('unexpected')},structured:async input=>({value:input.instructions.includes('"approved":boolean')?{approved:true,explicit:true,confidence:1}:{missing:[]},usage}),run:async request=>{
   row.modelCalls++;row.modelInputMarkerCounts.push((JSON.stringify(request.items).match(/SYNTHETIC_SELECTED_MEMORY/g)??[]).length)
   if(row.modelCalls===1)return {text:'',output:[{type:'function_call',callId:'delete',name:operation==='forget'?'memory__forget':'memory__apply',arguments:JSON.stringify({scopeType:stable.scopeType,scopeId:stable.scopeId,...operation==='apply-delete'?{changes:[{action:'delete',id:selected.id,expectedVersion:selected.version}]}:{}})}],usage}
   return {text:'The memory deletion has been committed.',output:[],usage}
  }}
  await api.enqueue({...identity,id,text:operation==='forget'?'Explicitly forget all saved facts in my personal scope. Confirm only after it is committed.':'Explicitly delete the selected saved fact and retain the other fact. Confirm only after it is committed.',mode:'execute',codeExecution:'disabled',deliveryMode:'text'})
  worker=createWorker({controlPlane:api,worker:{id},model})
  assert.equal(await worker.runNext(),true)
  const state=(await fixture.db.query('SELECT status,meta FROM lingxios.agent_work_items WHERE id=$1',[id])).rows[0]
  row.status=state.status
  const receipts=(await fixture.db.query("SELECT l.result FROM lingxios.agent_action_ledger l JOIN lingxios.agent_action_intents i USING(idempotency_key) WHERE i.intent->>'workId'=$1 AND i.intent->'action'->>'action'=$2",[id,operation==='forget'?'memory.forget':'memory.apply'])).rows
  row.committedDeletionReceipt=receipts.some(x=>x.result.ok===true&&x.result.executionState==='succeeded')
  row.selectedMissing=await api.memory.read(identity,stable,selected.id)===null
  row.remainingDocuments=(await api.memory.list(identity,stable)).items.length
  row.results=(await fixture.db.query('SELECT count(*)::int AS n FROM lingxios.agent_results WHERE work_id=$1',[id])).rows[0].n
  const epoch=(await fixture.db.query('SELECT epoch FROM lingxios.agent_memory_scopes WHERE tenant_id=$1 AND scope_type=$2 AND scope_id=$3',[stable.tenantId,stable.scopeType,stable.scopeId])).rows[0].epoch
  row.epochAdvanced=Number(epoch)>0
  row.admissionEpochStale=state.meta.memoryAdmission.epochs.some(e=>e.scopeId===stable.scopeId&&e.epoch<Number(epoch))
  assert.equal(row.committedDeletionReceipt,true);assert.equal(row.selectedMissing,true);assert.equal(row.remainingDocuments,operation==='forget'?0:1)
  assert.equal(row.results,1,'committed deletion must receive a durable confirmation')
  assert.notEqual(row.status,'failed');row.passed=true
 }catch(e){row.failure={type:e.name,assertion:e.code==='ERR_ASSERTION'?'durable-deletion-confirmation':undefined}}
 finally{try{await worker?.stop();await api?.stop()}finally{await fixture.close()}}
}
report.passed=report.cases.every(x=>x.passed)
await writeFile(out,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600})
console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1
