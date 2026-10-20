import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
const root=fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,'')
const { createLingxiOS }=await import(pathToFileURL(root+'/dist/src/app/index.js'))
const { AgentRuntime }=await import(pathToFileURL(root+'/dist/src/runtime/runtime.js'))
const phase=process.argv[2],dir=process.argv[3]
const marker=phase==='seed'?'MEMORY_ONLY_'+randomUUID().replaceAll('-','').slice(0,16):(JSON.parse(await readFile(dir+'/private-fixture.json','utf8'))).marker
const count=value=>(JSON.stringify(value)?.match(new RegExp(marker,'g'))??[]).length
const db=new PGlite(dir+'/db')
const pool={ query:async(sql,params)=>{const r=await db.query(sql,params);return{rows:r.rows,rowCount:r.affectedRows??r.rows.length}},connect:async()=>({query:pool.query,release(){}})}
if(phase==='seed')await db.exec(await readFile(root+'/db/schema.sql','utf8'))
const identity={tenantId:'t',agentId:'a',principalId:'u',sessionId:'s'}
const memory={contextBudget:{optionalRecall:true},resolveScopes:async actor=>actor.tenantId==='t'&&actor.principalId==='u'?[{tenantId:'t',scopeType:'user',scopeId:'u',continuity:'principal'}]:[]}
const logs=[],calls=[],events=[]
const logger={debug(){},info(){},warn(){},error(){},child(){return this}}
const api=await createLingxiOS({database:pool,memory,background:{role:'passive'},performance:{notifications:false},logger})
const host=api.connectWorker({workerId:'isolated-probe',workKinds:['turn']})
const scope=(await api.memory.scopes(identity))[0]
const usage={available:true,inputTokens:20,outputTokens:5}
let docId,activeRun,localCalls=0
const record=(purpose,request)=>calls.push({run:activeRun,purpose,markerCount:count(request.items),
 receiptCount:count(request.items.filter(x=>x.type==='function_call_output')),
 summaryCount:count(request.items.filter(x=>typeof x.content==='string'&&x.content.startsWith('Conversation continuity summary'))),
 dynamicMemoryCount:count(request.items.filter(x=>typeof x.content==='string'&&x.content.startsWith('Cognitive memory snapshot')))})
const model={modelId:'synthetic-local',structured:async()=>{throw new Error('unexpected structured')},
 compact:async request=>{record('compaction',request);return{value:JSON.stringify({observedResults:marker,decisions:'',remainingWork:'',uncertainties:''}),model:'synthetic-local',usage}},
 run:async request=>{record('turn',request);localCalls++
  if(activeRun==='seed'&&localCalls===1)return{text:'',output:[{type:'function_call',callId:'read',name:'memory__read',arguments:JSON.stringify({scopeType:scope.scopeType,scopeId:scope.scopeId,id:docId,length:2400})}],usage}
  if(activeRun==='compact-after-forget')await new Promise(r=>setTimeout(r,100))
  return{text:'Done.',output:[],usage}
 }}
async function run(id,compaction){
 activeRun=id;localCalls=0
 await api.enqueue({...identity,id,text:id==='seed'?'Read the selected saved document, then reply Done.':'Reply Done.',mode:'read',codeExecution:'disabled',deliveryMode:'text'})
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
  const before=(await db.query('SELECT history,summary FROM lingxios.agent_os_sessions')).rows[0]
  assert.ok(count(before.history)>0)
  await api.memory.forget(identity,scope)
  assert.equal(await api.memory.read(identity,scope,docId),null)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM lingxios.agent_memories')).rows[0].n,0)
  await run('warm-after-forget')
  await run('compact-after-forget',{contextWindowTokens:128000,softRatio:0.001,hardRatio:0.9,keepTailItems:0,maxSummaryChars:2000})
  await writeFile(dir+'/private-fixture.json',JSON.stringify({marker}),{mode:0o600})
 }
 else await run('process-restart-after-forget')
 const state=(await db.query('SELECT history,summary FROM lingxios.agent_os_sessions')).rows[0]
 const work=(await db.query('SELECT meta FROM lingxios.agent_work_items')).rows
 const messages=(await db.query('SELECT message FROM lingxios.agent_results')).rows
 const receipt={phase,source:'current-worktree',processId:process.pid,calls,events,
  memoryRows:(await db.query('SELECT count(*)::int AS n FROM lingxios.agent_memories')).rows[0].n,
  userRequestMarkerCount:count(work),finalAnswerMarkerCount:count(messages),persistedHistoryMarkerCount:count(state.history),persistedSummaryMarkerCount:count(state.summary)}
 assert.equal(receipt.userRequestMarkerCount,0);assert.equal(receipt.finalAnswerMarkerCount,0)
 await writeFile(dir+'/'+phase+'-counts.json',JSON.stringify(receipt,null,2)+'\n',{mode:0o600})

}finally{await api.stop();await db.close()}
