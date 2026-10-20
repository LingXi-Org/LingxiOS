import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
const root=process.env.LINGXIOS_FORGET_FIXTURE_ROOT??fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,'')
const { createLingxiOS }=await import(pathToFileURL(root+'/dist/src/app/index.js'))
const { AgentRuntime }=await import(pathToFileURL(root+'/dist/src/runtime/runtime.js'))
const phase=process.argv[2],dir=process.argv[3],scenario=process.argv[4]??'receipt'
const marker=phase==='seed'?'MEMORY_ONLY_'+randomUUID().replaceAll('-','').slice(0,16):(JSON.parse(await readFile(dir+'/private-fixture.json','utf8'))).marker
const count=value=>(JSON.stringify(value)?.match(new RegExp(marker,'g'))??[]).length
const db=new PGlite(dir+'/db')
const pool={ query:async(sql,params)=>{const r=await db.query(sql,params);return{rows:r.rows,rowCount:r.affectedRows??r.rows.length}},connect:async()=>({query:pool.query,release(){}})}
if(phase==='seed')await db.exec(await readFile(root+'/db/schema.sql','utf8'))
const identity={tenantId:'t',agentId:'a',principalId:'u',sessionId:'s'}
const memory={contextBudget:{optionalRecall:true},resolveScopes:async actor=>actor.tenantId==='t'&&actor.principalId==='u'?[{tenantId:'t',scopeType:'user',scopeId:'u',continuity:'principal'}]:[]}
const calls=[],events=[];let durablePreserved=true,summaryBeforeForgetCount=0
const logger={debug(){},info(){},warn(){},error(){},child(){return this}}
const contextProvider={loadContext:async work=>({persona:{name:'Synthetic',role:'assistant',instructions:''},capabilities:[],messages:[
 {ref:'public-user',authorId:'u',authorName:'User',authorKind:'human',body:'PUBLIC_USER_FACT',createdAt:''},
 {ref:'public-final',authorId:'a',authorName:'Assistant',authorKind:'agent',body:'PUBLIC_FINAL_FACT',createdAt:''},
 {ref:work.triggerRef,authorId:'u',authorName:'User',authorKind:'human',body:String(work.meta.text),createdAt:''},
]})}
const api=await createLingxiOS({database:pool,memory,contextProvider,background:{role:'passive'},performance:{notifications:false},logger})
const host=api.connectWorker({workerId:'isolated-probe',workKinds:['turn']})
const scope=(await api.memory.scopes(identity))[0]
const usage={available:true,inputTokens:20,outputTokens:5}
let docId,activeRun,localCalls=0
const record=(purpose,request)=>calls.push({run:activeRun,purpose,markerCount:count(request.items),
 publicUserCount:JSON.stringify(request.items).includes('PUBLIC_USER_FACT')?1:0,publicFinalCount:JSON.stringify(request.items).includes('PUBLIC_FINAL_FACT')?1:0,
 controlFieldCount:['sourceEpochs','memorySources','legacyMemoryCells','legacyMemoryInvalidated','forgottenAt'].filter(key=>JSON.stringify(request.items).includes(key)).length,
 receiptCount:count(request.items.filter(x=>x.type==='function_call_output')),
 summaryCount:count(request.items.filter(x=>typeof x.content==='string'&&x.content.startsWith('Conversation continuity summary'))),
 dynamicMemoryCount:count(request.items.filter(x=>typeof x.content==='string'&&x.content.startsWith('Cognitive memory snapshot')))})
const model={modelId:'synthetic-local',structured:async()=>{throw new Error('unexpected structured')},
 compact:async request=>{record('compaction',request);return{value:JSON.stringify({observedResults:count(request.items)?marker:'Neutral observations.',decisions:'',remainingWork:'',uncertainties:''}),model:'synthetic-local',usage}},
 run:async request=>{record('turn',request);localCalls++
  if(activeRun==='seed'&&localCalls===1)return{text:'',output:[{type:'function_call',callId:'read',name:'memory__read',arguments:JSON.stringify({scopeType:scope.scopeType,scopeId:scope.scopeId,id:docId,length:2400})}],usage}
  if(activeRun==='compact-after-forget'||activeRun==='summary-before-forget')await new Promise(r=>setTimeout(r,100))
  return{text:'Done.',output:[],usage}
 }}
async function run(id,compaction){
 activeRun=id;localCalls=0
 await api.enqueue({...identity,id,text:id==='seed'?'Read the selected saved document, then reply Done.':['warm-after-forget','warm-before-forget'].includes(id)?'Reply Done. '+('Ordinary user context. '.repeat(160)):'Reply Done.',mode:'read',codeExecution:'disabled',deliveryMode:'text'})
 const work=await host.claimWork();assert.equal(work?.id,id)
 await new AgentRuntime(host,model,{execute:async()=>{throw new Error('unexpected kernel')}},{logger,...compaction?{compaction}: {}}).runWork(work)
 const row=(await db.query('SELECT status FROM lingxios.agent_work_items WHERE id=$1',[id])).rows[0]
 assert.equal(row.status,'succeeded',`run ${id} must complete`)
 const eventRows=(await db.query('SELECT kind FROM lingxios.agent_run_events WHERE run_id=$1',[id])).rows
 events.push({id,kinds:eventRows.map(x=>x.kind)})
}
try{
 if(phase==='seed'){
  docId=(await api.memory.initialize(identity,{scope,documents:[{path:'source.md',title:'Selected record',description:'Selected record',body:marker+' '+('neutral source detail. '.repeat(220)),layer:'reference'}],idempotencyKey:'seed',sourceRef:'settings'})).documents[0].id
  await run('seed')
  assert.equal(calls[0].markerCount,0,'first model request must not have memory body before tool read')
  assert.ok(calls.some(x=>x.run==='seed'&&x.receiptCount>0),'real native memory read must reach authorized provider')
  if(scenario!=='receipt'){
   await run('warm-before-forget')
   await run('summary-before-forget',{contextWindowTokens:128000,softRatio:0.001,hardRatio:0.9,keepTailItems:0,maxSummaryChars:2000})
   summaryBeforeForgetCount=count((await db.query('SELECT summary FROM lingxios.agent_os_sessions')).rows[0].summary)
   assert.ok(summaryBeforeForgetCount>0,'summary must really derive from authorized memory before forgetting')
   if(scenario==='legacy')await db.exec("UPDATE lingxios.agent_os_sessions SET history=(SELECT jsonb_agg(item-'memorySources') FROM jsonb_array_elements(history) item)")
  }
  const before=(await db.query('SELECT history,summary FROM lingxios.agent_os_sessions')).rows[0]
  assert.ok(count(before.history)>0)
  const ledgerBefore=JSON.stringify((await db.query('SELECT idempotency_key,result FROM lingxios.agent_action_ledger ORDER BY idempotency_key')).rows)
  await api.memory.forget(identity,scope)
  durablePreserved=JSON.stringify(before)===JSON.stringify((await db.query('SELECT history,summary FROM lingxios.agent_os_sessions')).rows[0])
   &&ledgerBefore===JSON.stringify((await db.query('SELECT idempotency_key,result FROM lingxios.agent_action_ledger ORDER BY idempotency_key')).rows)
  assert.equal(durablePreserved,true,'forget does not delete or rewrite history, summary or receipt ledger')
  assert.equal(await api.memory.read(identity,scope,docId),null)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM lingxios.agent_memories')).rows[0].n,0)
  await run('warm-after-forget')
  if(scenario==='receipt')await run('compact-after-forget',{contextWindowTokens:128000,softRatio:0.001,hardRatio:0.9,keepTailItems:0,maxSummaryChars:2000})
  else assert.equal((await db.query('SELECT summary FROM lingxios.agent_os_sessions')).rows[0].summary,before.summary,'invalidated mixed summary stays durable')
  await writeFile(dir+'/private-fixture.json',JSON.stringify({marker}),{mode:0o600})
 }
 else await run('process-restart-after-forget')
 const state=(await db.query('SELECT history,summary FROM lingxios.agent_os_sessions')).rows[0]
 const work=(await db.query('SELECT meta FROM lingxios.agent_work_items')).rows
 const messages=(await db.query('SELECT message FROM lingxios.agent_results')).rows
 const receipt={phase,scenario,durablePreserved,summaryBeforeForgetCount,source:'current-worktree',processId:process.pid,calls,events,
  memoryRows:(await db.query('SELECT count(*)::int AS n FROM lingxios.agent_memories')).rows[0].n,
  userRequestMarkerCount:count(work),finalAnswerMarkerCount:count(messages),persistedHistoryMarkerCount:count(state.history),persistedSummaryMarkerCount:count(state.summary)}
 assert.equal(receipt.userRequestMarkerCount,0);assert.equal(receipt.finalAnswerMarkerCount,0)
 await writeFile(dir+'/'+phase+'-counts.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600})

}finally{await api.stop();await db.close()}
