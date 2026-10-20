// Diagnose one retained page in a cloned synthetic test DB. Never reset the
// original evidence database, replace provider responses, or expand budgets.
import assert from 'node:assert/strict'
import {pathToFileURL} from 'node:url'
import {readFile,writeFile} from 'node:fs/promises'
const [osRoot,loopRoot,out,mode='offline']=process.argv.slice(2)
assert.ok(['offline','page'].includes(mode))
const database='postgresql://postgres:lingxiloop-e2e-local@127.0.0.1:55432/lingxiloop_memory_continuity_diagnosis_test'
Object.assign(process.env,{NODE_ENV:'test',DOTENV_CONFIG_PATH:'/tmp/no-diagnosis-dotenv',DATABASE_URL:database,INTEGRATION_DATABASE_URL:database,
 REDIS_URL:'redis://127.0.0.1:56379/5',OPENAI_API_KEY:process.env.EVAL_CANDIDATE_API_KEY??'offline-no-provider',
 OPENAI_BASE_URL:process.env.EVAL_CANDIDATE_BASE_URL??'http://127.0.0.1:9/v1',OPENAI_MODEL:process.env.EVAL_CANDIDATE_MODEL??'offline',
 OPENAI_EMBEDDING_MODEL:'BAAI/bge-m3',LINGXILOOP_DISABLE_EMBEDDINGS:'0',OPEN_NOTEBOOK_ENABLED:'false',
 RESEND_API_KEY:'',ALERT_WEBHOOK_URL:'',WUKONG_USER_TOKEN_SECRET:'memory-isolated-user-token',
 LINGXILOOP_GATEWAY_HMAC_SECRET:'memory-isolated-gateway',LINGXILOOP_INVITE_BASE_URL:'http://127.0.0.1:52996',
 AGENT_OS_HOMES_ROOT:'/tmp/issue216-diagnosis-homes',AGENT_OS_MAX_MODEL_CALLS:'24',AGENT_OS_MAX_MODEL_TOKENS:'300000',
 AGENT_OS_MAX_MODEL_COST_MICROS:'400000',AGENT_OS_MAX_WORK_MS:'180000',
 AGENT_OS_INPUT_COST_MICROS_PER_MILLION:String(Math.ceil(8/7*1e6)),AGENT_OS_OUTPUT_COST_MICROS_PER_MILLION:String(Math.ceil(28/7*1e6))})
const load=(root,path)=>import(pathToFileURL(root+'/'+path).href)
const {pool,closeDatabasePools}=await load(loopRoot,'server/src/db/pool.ts')
const {prepareLingxiOSWorkerContext,lingxiOSControl,runtimeModelConfiguration,stopLingxiOSControl}=await load(loopRoot,'server/src/agent-runtime/runtime.ts')
const {ProductRuntimePolicy}=await load(loopRoot,'server/src/agent-runtime/context.ts')
const nativeRoot=loopRoot+'/node_modules/@lyyzka/lingxios'
const nativePackage=JSON.parse(await readFile(nativeRoot+'/package.json','utf8'))
const {createWorker}=await import(pathToFileURL(nativeRoot+'/'+nativePackage.exports['./worker'].import).href)
const {retryMemorySynthesis}=await load(osRoot,'dist/src/memory/evidence.js')
const {redis,sub}=await load(loopRoot,'server/src/redis.ts')
const report={stage:'initialize',mode,providerRequests:0,probeCompleted:false,featureAcceptance:false,operations:[]}
const originalFetch=globalThis.fetch
globalThis.fetch=async(...args)=>{
 const target=String(args[0] instanceof Request?args[0].url:args[0])
 if(target.startsWith(process.env.OPENAI_BASE_URL)){
  assert.equal(mode,'page','offline diagnosis must not contact a provider');report.providerRequests++
 }
 return originalFetch(...args)
}
let worker
try{
 report.stage='retained-job';const jobs=(await pool.query("SELECT * FROM lingxios.agent_work_items WHERE kind='memory_synthesis' AND status='failed'")).rows
 assert.equal(jobs.length,1)
 const job=jobs[0]
 assert.equal(job.attempts,2)
 report.before={status:job.status,attempts:job.attempts}
 const prior=(await pool.query(`SELECT l.result->'value' AS batch FROM lingxios.agent_action_ledger l JOIN lingxios.agent_action_intents i USING(idempotency_key)
  WHERE i.intent->>'workId'=$1 AND i.intent->'action'->>'action'='memory_synthesis.load' ORDER BY i.recorded_at DESC LIMIT 1`,[job.id])).rows[0].batch
 const identity={tenantId:job.tenant_id,agentId:job.agent_id,principalId:job.principal_id,
  sessionId:(await pool.query('SELECT session_id FROM lingxios.agent_work_items WHERE id=$1',[job.meta.sourceRunId])).rows[0].session_id,workId:job.meta.sourceRunId}
 const scope={tenantId:job.tenant_id,scopeType:job.meta.scopeType,scopeId:job.meta.scopeId}
 report.stage='control';prepareLingxiOSWorkerContext()
 const app=await lingxiOSControl()
 for(let i=0;i<10;i++){
  report.stage='reflect-'+i;const start=performance.now();await app.memory.reflect(identity,scope)
  report.operations.push({operation:'memory.reflect',ms:Math.round(performance.now()-start)})
 }
 if(mode==='page'){
  assert.ok(process.env.EVAL_CANDIDATE_API_KEY&&process.env.EVAL_CANDIDATE_BASE_URL&&process.env.EVAL_CANDIDATE_MODEL)
  // Invoke exactly the native due-failure scheduler; no timestamp or budget edit.
  report.stage='retry-scheduler';await retryMemorySynthesis(pool)
  const queued=(await pool.query("SELECT id FROM lingxios.agent_work_items WHERE status='queued'")).rows
  assert.deepEqual(queued.map(x=>x.id),[job.id])
  const connection={connectWorker(input){
   const host=app.connectWorker(input)
   return {...host,executeAction:async(work,action,signal)=>{
    const result=await host.executeAction(work,action,signal)
    if(action.action==='memory_synthesis.load'&&result.ok){
     const proof=x=>x.evidence.map(e=>({source:e.sourceRunId,version:e.requestVersion,hash:e.inputSha256,segment:e.segment}))
     assert.deepEqual(proof(result.value),proof(prior))
     report.samePage=true
    }
    return result
   }}
  }}
  worker=createWorker({controlPlane:connection,policy:new ProductRuntimePolicy(),worker:{id:'retained-page-diagnosis'},
   model:runtimeModelConfiguration({id:process.env.OPENAI_MODEL,apiKey:process.env.OPENAI_API_KEY,baseUrl:process.env.OPENAI_BASE_URL},90000)})
  report.stage='worker';const start=performance.now();assert.equal(await worker.runNext(),true)
  report.operations.push({operation:'worker.runNext',ms:Math.round(performance.now()-start)})
  const current=(await pool.query('SELECT status,attempts,fence,terminal_reason FROM lingxios.agent_work_items WHERE id=$1',[job.id])).rows[0]
  report.after=current
  report.validation=(await pool.query(`SELECT data->>'phase' AS phase,data->>'reason' AS reason FROM lingxios.agent_run_events
   WHERE run_id=$1 AND seq>=$2 AND kind='memory.synthesis.validation' ORDER BY seq`,[job.id,(Number(current.fence)-1)*100000])).rows
  report.source=(await pool.query(`SELECT status,segment_cursor FROM lingxios.agent_memory_evidence_scopes
   WHERE source_run_id=$1 AND scope_type=$2 AND scope_id=$3`,[job.meta.sourceRunId,job.meta.scopeType,job.meta.scopeId])).rows
 }
 report.stage='complete';report.probeCompleted=true
}catch(error){report.failure={type:error.name,code:error.code??null};process.exitCode=1}
finally{
 globalThis.fetch=originalFetch
 await worker?.stop();await stopLingxiOSControl();redis.disconnect();sub.disconnect();await closeDatabasePools()
 await writeFile(out,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600})
 console.log(JSON.stringify(report))
}
