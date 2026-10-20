import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {setTimeout as delay} from 'node:timers/promises'
const [root,out]=process.argv.slice(2)
assert.ok(root?.startsWith('/workspace/'));assert.ok(out?.startsWith('/workspace/shared/'))
const require=createRequire(root+'/package.json'),{Pool}=require('pg')
const load=p=>import(pathToFileURL(root+'/'+p).href)
const {PgWorkStore,PgModelBudgetStore}=await load('dist/src/control-plane/pg-store.js')
const {createMemoryRuntime}=await load('dist/src/memory/runtime.js')
const source=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()
const database='lingxios_issue216_review_'+process.pid
assert.match(database,/^lingxios_issue216_review_\d+$/)
const config={host:'127.0.0.1',port:55432,user:'postgres',password:'lingxiloop-e2e-local',connectionTimeoutMillis:3000,statement_timeout:5000,max:4}
const admin=new Pool({...config,database:'postgres',application_name:'issue216-private-review-admin'})
let created=false,pool,recordPool,finalPool
const report={source,node:process.versions.node,fixture:'new exclusive synthetic database on existing local PostgreSQL service',providerRequests:0,productionRequests:0,cases:[],passed:false}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
const safeError=e=>({type:e?.name??'Error',code:/^[A-Z0-9]{5}$/.test(e?.code??'')?e.code:undefined})
async function waitLock(name){for(let i=0;i<80;i++){const r=await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND application_name=$2 AND wait_event_type='Lock'",[database,name]);if(r.rows[0].n>0)return true;await delay(25)}return false}
async function setup(label){
 const store=new PgWorkStore(pool),id='review-'+label
 await store.enqueue({id,tenantId:'t',agentId:'a',principalId:'u',sessionId:id,kind:'turn',lane:'interactive',triggerRef:id,meta:{text:'Synthetic request'}})
 const work=await store.claim('review-worker-'+label);assert.equal(work.id,id)
 const memory=createMemoryRuntime(pool,{resolveScopes:async()=>[{tenantId:'t',scopeType:'user',scopeId:'u',continuity:'principal'}],contextBudget:{optionalRecall:true}})
 await memory.context(work)
 const proof={workId:id,fence:work.fence,leaseTokenHash:createHash('sha256').update(work.leaseToken).digest('hex')}
 const limits={maxModelCalls:5,maxTokens:1000,maxCostMicros:1000,reservedTokens:10,reservedCostMicros:10,deadlineAt:new Date(Date.now()+10000).toISOString()}
 return {work,memory,proof,limits}
}
async function runCase(name,fn){const entry={name,passed:false};report.cases.push(entry);try{await fn(entry);entry.passed=true}catch(e){entry.failure=safeError(e)}}
try{
 assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount,0)
 await admin.query('CREATE DATABASE '+database);created=true
 pool=new Pool({...config,database,application_name:'issue216-private-review-main'})
 recordPool=new Pool({...config,database,application_name:'issue216-private-review-record'})
 finalPool=new Pool({...config,database,application_name:'issue216-private-review-final'})
 report.postgres=(await pool.query('SHOW server_version')).rows[0].server_version
 await pool.query(await readFile(root+'/db/schema.sql','utf8'))
 await runCase('final-first',async r=>{
  const {work,memory,proof,limits}=await setup('final-first'),entered=deferred(),gate=deferred()
  const store=new PgModelBudgetStore(finalPool,async(db,w)=>{await memory.admit(db,w);entered.resolve();await gate.promise})
  await store.reserve(work.id,'call',limits,proof)
  const final=store.reserve(work.id,'call',{...limits,memoryAdmission:true},proof).then(value=>({value}),error=>({error}))
  await entered.promise
  let settled=false;const record=new PgModelBudgetStore(recordPool).record(work.id,'call',0,0,0,proof).then(()=>{settled=true})
  try{
   r.lockObserved=await waitLock('issue216-private-review-record');r.settledWhileFinalPending=settled
   r.persistedBeforeCommit=(await pool.query('SELECT input_tokens IS NOT NULL AS settled FROM lingxios.agent_model_budget_calls WHERE root_work_id=$1',[work.id])).rows[0].settled
  }finally{gate.resolve()}
  const result=await final;await record;r.finalAllowed=result.value?.allowed??false
  r.budget=(await pool.query('SELECT model_calls::int AS calls,tokens::int FROM lingxios.agent_model_budgets WHERE root_work_id=$1',[work.id])).rows[0]
  assert.equal(r.lockObserved,true);assert.equal(r.settledWhileFinalPending,false);assert.equal(r.persistedBeforeCommit,false);assert.equal(r.finalAllowed,true);assert.deepEqual(r.budget,{calls:1,tokens:0})
 })
 await runCase('record-first',async r=>{
  const {work,memory,proof,limits}=await setup('record-first'),entered=deferred(),gate=deferred()
  const wrapped={query:recordPool.query.bind(recordPool),connect:async()=>{const c=await recordPool.connect();return {release:()=>c.release(),query:async(sql,args)=>{const result=await c.query(sql,args);if(sql.includes('SELECT input_tokens,output_tokens,cost_micros,pricing')){entered.resolve();await gate.promise}return result}}}}
  const store=new PgModelBudgetStore(finalPool,memory.admit);await store.reserve(work.id,'call',limits,proof)
  const record=new PgModelBudgetStore(wrapped).record(work.id,'call',0,0,0,proof)
  await entered.promise
  let returned=false;const final=store.reserve(work.id,'call',{...limits,memoryAdmission:true},proof).then(value=>{returned=true;return {value}},error=>{returned=true;return {error}})
  try{r.lockObserved=await waitLock('issue216-private-review-final');r.returnedBeforeSettlement=returned}finally{gate.resolve()}
  await record;const result=await final;r.rejectedUnsettled=/unsettled/.test(result.error?.message??'')
  assert.equal(r.lockObserved,true);assert.equal(r.returnedBeforeSettlement,false);assert.equal(r.rejectedUnsettled,true)
 })
 await runCase('parallel-reserve-record',async r=>{
  const {work,memory,proof,limits}=await setup('parallel'),store=new PgModelBudgetStore(pool,memory.admit)
  await store.reserve(work.id,'first',limits,proof)
  const result=await Promise.all([store.reserve(work.id,'second',limits,proof),store.record(work.id,'first',0,0,0,proof)])
  r.completed=true;r.reserveAllowed=result[0].allowed;assert.equal(r.reserveAllowed,true)
 })
 for(const kind of ['lease','deadline'])await runCase(kind+'-after-wait',async r=>{
  const {work,memory,proof,limits}=await setup(kind)
  const store=new PgModelBudgetStore(pool,async(db,w)=>{await memory.admit(db,w);await delay(300)})
  await store.reserve(work.id,'call',limits,proof)
  if(kind==='lease')await pool.query("UPDATE lingxios.agent_work_items SET lease_expires_at=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",[work.id])
  else await pool.query("UPDATE lingxios.agent_model_budgets SET deadline_at=clock_timestamp()+interval '150 milliseconds' WHERE root_work_id=$1",[work.id])
  const result=await store.reserve(work.id,'call',{...limits,memoryAdmission:true},proof).then(value=>({value}),error=>({error}))
  r.rejected=kind==='lease'?/live uncancelled/.test(result.error?.message??''):result.value?.allowed===false&&result.value?.dimension==='deadline'
  assert.equal(r.rejected,true)
  await store.record(work.id,'call',0,0,0,proof)
  r.zeroTokenSettlement=(await pool.query('SELECT tokens::int FROM lingxios.agent_model_budgets WHERE root_work_id=$1',[work.id])).rows[0].tokens===0
  assert.equal(r.zeroTokenSettlement,true)
 })
 report.passed=report.cases.every(c=>c.passed)
}catch(e){report.failure=safeError(e)}finally{
 await Promise.allSettled([pool?.end(),recordPool?.end(),finalPool?.end()])
 if(created){try{await admin.query('DROP DATABASE '+database);report.cleanedUp=true}catch(e){report.cleanupFailure=safeError(e)}}
 await admin.end()
 report.sourceHashes={}
 for(const path of ['src/control-plane/pg-store.ts','src/memory/admission.ts','src/memory/runtime.ts','src/model/execution.ts'])report.sourceHashes[path]=createHash('sha256').update(await readFile(root+'/'+path)).digest('hex')
 await writeFile(out,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600})
 console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1
}
