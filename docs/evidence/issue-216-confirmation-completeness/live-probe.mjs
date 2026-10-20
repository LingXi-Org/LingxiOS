// Existing authorized provider only. PGlite contains synthetic data; no product
// database or production message is changed. Every model call uses createWorker.
import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
const [root,out]=process.argv.slice(2),load=p=>import(pathToFileURL(root+'/'+p).href)
const {memoryFixture}=await load('dist/test/memory-fixture.js')
const {createLingxiOS}=await load('dist/src/app/index.js')
const {createWorker}=await load('dist/src/worker/factory.js')
const modelId=process.env.EVAL_CANDIDATE_MODEL,baseUrl=process.env.EVAL_CANDIDATE_BASE_URL,apiKey=process.env.EVAL_CANDIDATE_API_KEY
assert.ok(modelId&&baseUrl&&apiKey,'existing authorized provider configuration is required')
const model={id:modelId,baseUrl,apiKey,maxThinkingTokens:0,requestTimeoutMs:60_000,maxOutputTokens:4096,contextWindowTokens:128_000}
const modelBudget={maxModelCalls:12,maxTokens:180000,maxCostMicros:400000,wallClockMs:120000,
 inputCostMicrosPerMillion:Math.ceil(Number(process.env.EVAL_CANDIDATE_INPUT_CNY_PER_MILLION)/7*1e6),
 outputCostMicrosPerMillion:Math.ceil(Number(process.env.EVAL_CANDIDATE_OUTPUT_CNY_PER_MILLION)/7*1e6)}
assert.ok(Number.isFinite(modelBudget.inputCostMicrosPerMillion)&&Number.isFinite(modelBudget.outputCostMicrosPerMillion))
const report={source:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
 providerHost:new URL(baseUrl).hostname,model:modelId,productionRequests:0,cases:[],requests:[],passed:false}
const originalFetch=globalThis.fetch
let phase='deletion'
globalThis.fetch=async(...args)=>{
 const start=Date.now(),response=await originalFetch(...args)
 const target=String(args[0] instanceof Request?args[0].url:args[0])
 if(target.startsWith(baseUrl))report.requests.push({phase,status:response.status,elapsedMs:Date.now()-start})
 return response
}
const scope={tenantId:'t',scopeType:'user',scopeId:'u',continuity:'principal'}
const f=await memoryFixture({resolveScopes:async()=>[scope]})
let app,worker
try{
 app=await createLingxiOS({database:f.pool,memory:f.options,modelBudget,background:{role:'passive'},performance:{notifications:false}})
 worker=createWorker({controlPlane:app,worker:{id:'real-memory-confirmation'},model,modelBudget})
 const identity={tenantId:'t',agentId:'a',principalId:'u',sessionId:'real-delete'}
 const stable=(await app.memory.scopes(identity))[0]
 await app.memory.initialize(identity,{scope:stable,idempotencyKey:'real-seed',sourceRef:'synthetic-settings',documents:[
  {path:'synthetic.md',title:'Synthetic preference',description:'Synthetic',body:'SYNTHETIC_FORGOTTEN_MARKER 喜欢用树状图整理学习材料。',layer:'core',locked:true}
 ]})
 await app.enqueue({...identity,id:'real-delete',text:'请立即忘记并删除我的个人长期档案里的全部记忆。请执行原生 memory.forget；只在成功提交后确认，不要重复被删除的内容。',
  mode:'execute',codeExecution:'disabled',deliveryMode:'action'})
 assert.equal(await worker.runNext(),true)
 const messages=(await f.pool.query("SELECT message FROM lingxios.agent_results WHERE work_id='real-delete'")).rows
 const deletionReceipts=(await f.pool.query(`SELECT l.result FROM lingxios.agent_action_ledger l JOIN lingxios.agent_action_intents i USING(idempotency_key)
  WHERE i.intent->>'workId'='real-delete' AND i.intent->'action'->>'action'='memory.forget' AND l.result->>'ok'='true'`)).rows
 const deletion={name:'committed-deletion',passed:false,receipts:deletionReceipts.length,results:messages.length,
  remaining:(await app.memory.list(identity,stable)).items.length,
  confirmationMarkerCount:(JSON.stringify(messages).match(/SYNTHETIC_FORGOTTEN_MARKER/g)??[]).length}
 report.cases.push(deletion)
 assert.equal(deletion.receipts,1);assert.equal(deletion.results,1);assert.equal(deletion.remaining,0);assert.equal(deletion.confirmationMarkerCount,0)
 assert.equal(messages[0].message.envelope.goalOutcome.status,'partial')
 deletion.passed=true
 phase='long-source'
 const middle='我每周六上午在图书馆做统计实验',tail='我正在筹备名为星河的数学科普展'
 const filler='这是一段普通课程练习过程说明，不代表学生已经掌握相关知识。'.repeat(170)
 const source=await f.source({id:'real-long-source',scopes:[stable],text:`${filler}\n${middle}。\n${filler}\n${tail}。`})
 const deadline=Date.now()+180000
 let jobs=0,status,cursor,segments
 for(;;){
  assert.ok(Date.now()<deadline,'bounded wall time')
  await app.memory.reflect({...identity,sessionId:source.work.sessionId},stable)
  while(await worker.runNext())assert.ok(++jobs<=16,'bounded source jobs')
  const row=(await f.pool.query(`SELECT s.status,s.segment_cursor,(SELECT count(*)::int FROM lingxios.agent_memory_evidence_segments p
    WHERE p.source_run_id=s.source_run_id) AS segments FROM lingxios.agent_memory_evidence_scopes s WHERE source_run_id=$1`,[source.work.id])).rows[0]
  status=row.status;cursor=row.segment_cursor;segments=row.segments
  if(status!=='pending')break
  assert.ok(cursor<segments,'incomplete source must not be passed off as complete')
 }
 const outcomes=(await f.pool.query(`SELECT l.result->'value'->>'outcome' AS outcome FROM lingxios.agent_action_ledger l
  JOIN lingxios.agent_action_intents i USING(idempotency_key) JOIN lingxios.agent_work_items w ON w.id=i.intent->>'workId'
  WHERE w.kind='memory_synthesis' AND i.intent->'action'->>'action'='memory_synthesis.apply' ORDER BY i.recorded_at`)).rows.map(r=>r.outcome)
 const rejectedPages=outcomes.filter(x=>x==='rejected').length
 const docs=await Promise.all((await app.memory.list(identity,stable)).items.map(x=>app.memory.read(identity,stable,x.id)))
 const bodies=docs.map(x=>x.body).join('\n')
 const extraction={name:'long-source-review-completeness',passed:false,jobs,status,cursor,segments,rejectedPages,
  middleFacts:/周六|星期六/.test(bodies),tailFacts:/星河/.test(bodies),allFactsAccepted:false,
  maintenance:(await app.memory.doctor(identity,stable)).maintenance}
 report.cases.push(extraction)
 assert.ok(segments>2);assert.equal(cursor,segments)
 assert.equal(status,rejectedPages?'rejected':'processed')
 assert.equal(extraction.maintenance.retryableSources,0)
 if(status==='processed'){assert.ok(extraction.middleFacts&&extraction.tailFacts,'processed must include both eligible facts');extraction.allFactsAccepted=true}
 extraction.passed=true
 report.usage=(await f.pool.query(`SELECT count(*)::int AS calls,COALESCE(sum(cost_micros),0)::int AS "costMicros",
  COUNT(*) FILTER(WHERE observation->'usage'->>'available'='true')::int AS measured FROM lingxios.agent_model_budget_calls`)).rows[0]
 assert.ok(report.usage.calls>0&&report.usage.measured>0&&report.usage.costMicros<1000000)
 report.passed=report.cases.every(x=>x.passed)
}catch(error){report.failure={type:error.name,code:error.code??null,stage:phase,stackLocation:String(error.stack).split('\n').slice(1,3).map(x=>x.replace(root,'<source>'))};process.exitCode=1}
finally{
 globalThis.fetch=originalFetch
 await worker?.stop();await app?.stop();await f.close()
 await writeFile(out,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600})
 console.log(JSON.stringify(report))
}
