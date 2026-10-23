import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { PgActionLedger, PgWorkStore, withTransaction } from '../dist/src/control-plane/pg-store.js'
import { createMemoryRuntime } from '../dist/src/memory/runtime.js'
import { captureMemoryEvidence } from '../dist/src/memory/evidence.js'
import { sessionKeyOf } from '../dist/src/protocol/types.js'
import { toolExecutor } from '../dist/src/tools/executor.js'
import { toolContractHash } from '../dist/src/tools/contracts.js'
const gate=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve:()=>resolve()}}
async function fixture(pool, label) {
  const tenantId='synthetic-forget-'+label, identity={tenantId,agentId:'agent',principalId:'human',sessionId:'source-session'}
  const scope={tenantId,scopeType:'user',scopeId:'human'},options={resolveScopes:async()=>[scope]}
  const source={...identity,id:tenantId+'-source',kind:'turn',lane:'interactive',triggerRef:'synthetic-source',fence:0,homeEpoch:1}
  const store=new PgWorkStore(pool,{leaseTtlMs:60_000})
  await store.enqueue(source)
  await pool.query("UPDATE lingxios.agent_work_items SET status='succeeded' WHERE id=$1",[source.id])
  const request={version:1,workId:source.id,tenantId,sessionId:source.sessionId,authorId:'human',sourceRef:'synthetic-source',originalText:'I prefer diagrams.',revisions:[],attachments:[],evidence:{}}
  await pool.query("INSERT INTO lingxios.agent_os_sessions(session_key,tenant_id,agent_id,session_id,request_snapshot) VALUES($1,$2,$3,$4,$5::jsonb)",[sessionKeyOf(source),tenantId,source.agentId,source.sessionId,JSON.stringify(request)])
  await withTransaction(pool,db=>captureMemoryEvidence(db,source,{body:'Understood.',envelope:{requestVersion:1}},[scope]))
  const memory=createMemoryRuntime(pool,options),scheduled=await memory.api.reflect(identity,scope)
  assert.equal(scheduled.jobIds.length,1)
  const work=await store.claim('synthetic-maintenance',undefined,['memory_synthesis'])
  assert.equal(work.id,scheduled.jobIds[0]);assert.equal(work.kind,'memory_synthesis')
  const tool=memory.tools.find(item=>item.action==='memory_synthesis.load')
  const action={runId:work.id,cellId:'load',callIndex:0,idempotencyKey:JSON.stringify([work.id,'load',0]),action:tool.action,args:{}}
  await new PgActionLedger(pool).reserve(action.idempotencyKey,'synthetic-fingerprint',{workId:work.id,tenantId,principalId:'human',agentId:'agent',sessionId:work.sessionId,threadId:null,requestVersion:1,action,toolContractHash:toolContractHash(tool)})
  return { tenantId, identity, scope, options, source, store, memory, work, tool, action }
}
const executionOptions = () => ({requestVersion:1,deadlineAt:new Date(Date.now()+15000).toISOString(),signal:AbortSignal.timeout(15000)})
const cleanup = async (pool, work) => {
  await pool.query("UPDATE lingxios.agent_work_items SET status='cancelled' WHERE id=$1", [work.id])
  await pool.query('DELETE FROM lingxios.agent_os_session_leases WHERE work_id=$1', [work.id])
}
export async function memoryForgetLockRegression(pool){
  const { identity, scope, options, source, work, tool, action } = await fixture(pool, 'first')
  const held=gate(),resume=gate(),connected=gate(),errors=[]
  let forgetPid,toolPid,paused=false
  const wrapped=forget=>({query:(sql,args)=>pool.query(sql,args),async connect(){
    const client=await pool.connect(),pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    if(forget)forgetPid=pid;else{toolPid=pid;connected.resolve()}
    return {async query(sql,args){try{
      const result=await client.query(sql,args)
      if(forget&&!paused&&sql.includes('FROM lingxios.agent_memory_scopes')&&sql.includes('FOR UPDATE')){paused=true;held.resolve();await resume.promise}
      return result
    }catch(error){errors.push({side:forget?'forget':'tool',code:error.code});throw error}},release:()=>client.release()}
  }})
  let forgetting,executing
  try{
    forgetting=createMemoryRuntime(wrapped(true),options).api.forget(identity,scope);void forgetting.catch(()=>{})
    await Promise.race([held.promise,delay(5000).then(()=>{throw Error('forget did not lock scope')})])
    executing=toolExecutor(wrapped(false),[tool],undefined,options).execute(work,action,executionOptions());void executing.catch(()=>{})
    await connected.promise
    const deadline=Date.now()+5000
    while(!(await pool.query('SELECT pg_blocking_pids($1) AS pids',[toolPid])).rows[0].pids.includes(forgetPid)){
      assert.ok(Date.now()<deadline,'real native synthesis must block behind forget scope');await delay(10)
    }
    resume.resolve()
    const results=await Promise.allSettled([forgetting,executing])
    console.log(JSON.stringify({entrypoints:['memory.api.forget','toolExecutor(memory_synthesis.load)'],errors,results:results.map(r=>r.status==='rejected'?{status:r.status,code:r.reason.code}:{status:r.status,ok:r.value.ok})}))
    assert.equal(errors.some(e=>e.code==='40P01'),false,'forget and actual synthesis must not deadlock, including masked retries')
    assert.equal(results[0].status, 'fulfilled')
    assert.equal(results[0].value.epoch, 1)
    assert.ok(results[1].status === 'rejected' || results[1].value.ok === false, 'forgotten work cannot execute')
    const saved = (await pool.query('SELECT cancel_requested_at,meta FROM lingxios.agent_work_items WHERE id=$1', [work.id])).rows[0]
    assert.ok(saved.cancel_requested_at)
    assert.equal(saved.meta.memorySnapshot, undefined)
    assert.equal((await pool.query('SELECT 1 FROM lingxios.agent_memory_evidence_segments WHERE source_run_id=$1', [source.id])).rowCount, 0)
    assert.equal((await pool.query('SELECT 1 FROM lingxios.agent_action_ledger WHERE idempotency_key=$1', [action.idempotencyKey])).rowCount, 0)
    console.log('atomic forget and real native synthesis peer passed')
  }finally{resume.resolve();await Promise.allSettled([forgetting,executing].filter(Boolean));await cleanup(pool,work)}
  await synthesisFirst(pool)
  await memorySynthesisInvalidationRegression(pool)
}

/** The reverse order commits the valid load first, then forget clears it atomically. */
async function synthesisFirst(pool) {
  const { identity, scope, options, work, tool, action } = await fixture(pool, 'second')
  const held=gate(),resume=gate(),connected=gate(),errors=[]
  let firstPid,secondPid,paused=false
  const wrapped=first=>({query:(sql,args)=>pool.query(sql,args),async connect(){
    const client=await pool.connect(),pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    if(first)firstPid=pid;else{secondPid=pid;connected.resolve()}
    return {async query(sql,args){try {
      const result=await client.query(sql,args)
      if(first&&!paused&&sql.includes('FROM lingxios.agent_memory_scopes')&&sql.includes('FOR UPDATE')){paused=true;held.resolve();await resume.promise}
      return result
    }catch(error){errors.push(error.code);throw error}},release:()=>client.release()}
  }})
  let executing,forgetting
  try {
    executing=toolExecutor(wrapped(true),[tool],undefined,options).execute(work,action,executionOptions());void executing.catch(()=>{})
    await Promise.race([held.promise,delay(5000).then(()=>{throw Error('native synthesis did not lock scope')})])
    forgetting=createMemoryRuntime(wrapped(false),options).api.forget(identity,scope);void forgetting.catch(()=>{})
    await connected.promise
    const deadline=Date.now()+5000
    while(!(await pool.query('SELECT pg_blocking_pids($1) AS pids',[secondPid])).rows[0].pids.includes(firstPid)){
      assert.ok(Date.now()<deadline,'forget must wait behind the real native scope lock');await delay(10)
    }
    resume.resolve()
    const [loaded,forgotten]=await Promise.all([executing,forgetting])
    assert.equal(errors.includes('40P01'),false)
    assert.equal(loaded.ok,true)
    assert.ok(loaded.value.evidence.length>0)
    assert.equal(forgotten.epoch,1)
    const row=(await pool.query('SELECT meta,cancel_requested_at FROM lingxios.agent_work_items WHERE id=$1',[work.id])).rows[0]
    assert.ok(row.cancel_requested_at);assert.equal(row.meta.memorySnapshot,undefined)
    assert.equal((await pool.query('SELECT 1 FROM lingxios.agent_action_ledger WHERE idempotency_key=$1',[action.idempotencyKey])).rowCount,1)
    await assert.rejects(toolExecutor(pool,[tool],undefined,options).execute(work,action,executionOptions()))
    console.log('native synthesis before atomic forget passed; stale receipt cannot bypass cancellation')
  } finally { resume.resolve();await Promise.allSettled([executing,forgetting].filter(Boolean));await cleanup(pool,work) }
}

/** No discovery snapshot can stand in for final authorization after a wait. */
export async function memorySynthesisInvalidationRegression(pool, mutations = ['fence','revision','cancel','scope','epoch','revoked','caller-scope','caller-kind','lease-time']) {
  for (const mutation of mutations) {
    const {scope,options,work,tool,action,store}=await fixture(pool,mutation)
    const errors=[],lockedScopes=[]
    let changed=false
    const wrapped={query:(sql,args)=>pool.query(sql,args),async connect(){
      const client=await pool.connect()
      return {async query(sql,args){try {
        const result=await client.query(sql,args)
        if(sql.includes('FROM lingxios.agent_memory_scopes')&&sql.includes('FOR UPDATE')) {
          lockedScopes.push(args.slice(0,3))
          if(!changed&&!mutation.startsWith('caller-')) {
            changed=true
            if(mutation==='lease-time') {
              const deadline=Date.now()+5000
              while(!(await pool.query('SELECT clock_timestamp()>=lease_expires_at AS expired FROM lingxios.agent_work_items WHERE id=$1',[work.id])).rows[0].expired) {
                assert.ok(Date.now()<deadline,'synthetic lease must expire naturally');await delay(10)
              }
            }
            if(mutation==='fence')await pool.query('UPDATE lingxios.agent_work_items SET fence=fence+1 WHERE id=$1',[work.id])
            if(mutation==='revision')await store.addSteer(work.id,'Synthetic replacement request')
            if(mutation==='cancel')await store.requestCancel(work.id)
            if(mutation==='revoked')options.resolveScopes=async()=>[]
            if(mutation==='scope')await pool.query("UPDATE lingxios.agent_work_items SET meta=jsonb_set(meta,'{scopeId}','\"other\"'::jsonb) WHERE id=$1",[work.id])
            if(mutation==='epoch')await pool.query("UPDATE lingxios.agent_work_items SET meta=jsonb_set(meta,'{epoch}','99'::jsonb) WHERE id=$1",[work.id])
          }
        }
        return result
      }catch(error){errors.push(error.code);throw error}},release:()=>client.release()}
    }}
    try {
      if(mutation==='lease-time')await pool.query("UPDATE lingxios.agent_work_items SET lease_expires_at=clock_timestamp()+INTERVAL '2 seconds' WHERE id=$1",[work.id])
      const supplied=mutation==='caller-scope'?{...work,meta:{...work.meta,scopeId:'other'}}:mutation==='caller-kind'?{...work,kind:'turn'}:work
      await assert.rejects(toolExecutor(wrapped,[tool],undefined,options).execute(supplied,action,executionOptions()))
      assert.equal(errors.includes('40P01'),false)
      if(mutation.startsWith('caller-'))assert.equal(lockedScopes.length,0,'forged work must not lock any scope')
      else assert.ok(lockedScopes.length>0)
      assert.ok(lockedScopes.every(args=>args[0]===scope.tenantId&&args[1]===scope.scopeType&&args[2]===scope.scopeId))
      assert.equal((await pool.query('SELECT 1 FROM lingxios.agent_action_ledger WHERE idempotency_key=$1',[action.idempotencyKey])).rowCount,0)
      assert.equal((await pool.query('SELECT meta FROM lingxios.agent_work_items WHERE id=$1',[work.id])).rows[0].meta.memorySnapshot,undefined)
      console.log('native synthesis lock proof invalidation passed: '+mutation)
    } finally {await cleanup(pool,work)}
  }
}
