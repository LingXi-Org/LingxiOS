import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { PgActionLedger, PgModelBudgetStore, PgWorkStore } from '../dist/src/control-plane/pg-store.js'
import { hashToken } from '../dist/src/control-plane/memory-store.js'
import { createMemoryRuntime } from '../dist/src/memory/runtime.js'
import { sessionKeyOf } from '../dist/src/protocol/types.js'
import { toolExecutor } from '../dist/src/tools/executor.js'
import { toolContractHash } from '../dist/src/tools/contracts.js'

const gate = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

/** Exercise the real outer native work/intent lock, including existing retries. */
export async function memoryToolAdmissionLockRegression(pool) {
  const tenantId='memory-native-lock',id=tenantId+'-work',sessionId=tenantId+'-session'
  const scope={tenantId,scopeType:'user',scopeId:'human'},options={resolveScopes:async()=>[scope],contextBudget:{optionalRecall:true}}
  const store=new PgWorkStore(pool,{leaseTtlMs:60_000})
  await store.enqueue({id,tenantId,agentId:'agent',principalId:'human',sessionId,kind:'turn',lane:'interactive',triggerRef:'synthetic'})
  const work=await store.claim('memory-native-lock-worker')
  assert.equal(work?.id,id)
  const memory=createMemoryRuntime(pool,options)
  await memory.context(work)
  const proof={workId:id,fence:work.fence,leaseTokenHash:hashToken(work.leaseToken)}
  const limits={maxModelCalls:4,maxTokens:1000,maxCostMicros:1000,deadlineAt:new Date(Date.now()+60_000).toISOString()}
  await new PgModelBudgetStore(pool,memory.admit).reserve(id,'call',limits,proof)
  const tool=memory.tools.find(item=>item.action==='memory.reflect')
  assert.equal(tool.effect,'transaction')
  const action={runId:id,cellId:'reflect',callIndex:0,idempotencyKey:JSON.stringify([id,'reflect',0]),action:'memory.reflect',args:{scopeType:'user',scopeId:'human'}}
  await new PgActionLedger(pool).reserve(action.idempotencyKey,'synthetic-fingerprint',{workId:id,tenantId,principalId:'human',agentId:'agent',sessionId,
    threadId:null,requestVersion:1,action,toolContractHash:toolContractHash(tool)})
  const held=gate(),resume=gate(),toolConnected=gate(),databaseErrors=[]
  let admissionPid,toolPid,paused=false
  const wrapped=admission=>({query:(sql,params)=>pool.query(sql,params),async connect(){
    const client=await pool.connect(),pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    if(admission)admissionPid=pid;else{toolPid=pid;toolConnected.resolve()}
    return{async query(sql,params){
      try{
        const result=await client.query(sql,params)
        if(admission&&scopeLock(sql)&&!paused){paused=true;held.resolve();await resume.promise}
        return result
      }catch(error){databaseErrors.push(error.code);throw error}
    },release:()=>client.release()}
  }})
  const admissionPool=wrapped(true),toolPool=wrapped(false)
  const executor=toolExecutor(toolPool,[tool],undefined,options)
  let admission,execution
  try{
    admission=new PgModelBudgetStore(admissionPool,memory.admit).reserve(id,'call',{...limits,memoryAdmission:true},proof)
    void admission.catch(()=>{})
    await Promise.race([held.promise,delay(5000).then(()=>{throw Error('admission did not lock its scope')})])
    execution=executor.execute(work,action,{requestVersion:1,deadlineAt:new Date(Date.now()+15_000).toISOString(),signal:AbortSignal.timeout(15_000)})
    void execution.catch(()=>{})
    await toolConnected.promise
    const deadline=Date.now()+5000
    while(!(await pool.query('SELECT pg_blocking_pids($1) AS pids',[toolPid])).rows[0].pids.includes(admissionPid)){
      assert.ok(Date.now()<deadline,'the real native transaction must block behind admission');await delay(10)
    }
    resume.resolve()
    const results=await Promise.allSettled([admission,execution])
    assert.equal(databaseErrors.includes('40P01'),false,'native tool retries must not mask a transferred deadlock')
    assert.deepEqual(results.map(result=>result.status),['fulfilled','fulfilled'])
    assert.equal(results[0].value.allowed,true)
    assert.equal(results[1].value.ok,true)
    console.log('memory admission lock order: real transactional memory.reflect peer passed')
  }finally{
    resume.resolve();await Promise.allSettled([admission,execution].filter(Boolean))
    await pool.query("UPDATE lingxios.agent_work_items SET status='cancelled' WHERE id=$1",[id])
    await pool.query('DELETE FROM lingxios.agent_os_session_leases WHERE work_id=$1',[id])
  }
}
const scopeLock = sql => sql.includes('FROM lingxios.agent_memory_scopes') && sql.includes('FOR UPDATE')

/** Two real entry points, two real transactions; barriers never acquire locks. */
export async function memoryAdmissionLockRegression(pool, boundaries = ['model', 'context']) {
  for (const boundary of boundaries) for (const mutation of ['none','revoked']) {
    const tenantId = `memory-lock-${boundary}-${mutation}`
    const scope = { tenantId, scopeType: 'user', scopeId: 'human' }
    let allowed = true
    const options = { resolveScopes: async () => allowed ? [scope] : [], contextBudget: { optionalRecall: true } }
    const store = new PgWorkStore(pool, { leaseTtlMs: 60_000 })
    const id = `${tenantId}-work`, sessionId = `${tenantId}-session`
    await store.enqueue({ id, tenantId, agentId: 'agent', principalId: 'human', sessionId,
      kind: 'turn', lane: 'interactive', triggerRef: 'synthetic-request' })
    const work = await store.claim(`${tenantId}-worker`)
    assert.equal(work?.id, id)
    const request = { version: 1, workId: id, tenantId, sessionId, authorId: 'human', sourceRef: 'synthetic-request',
      originalText: 'Remember my explicit synthetic preference.', revisions: [], attachments: [], evidence: {} }
    await pool.query(`INSERT INTO lingxios.agent_os_sessions(session_key,tenant_id,agent_id,session_id,request_snapshot)
      VALUES($1,$2,'agent',$3,$4::jsonb)`, [sessionKeyOf(work), tenantId, sessionId, JSON.stringify(request)])
    const memory = createMemoryRuntime(pool, options)
    await memory.context(work)
    const proof = { workId: id, fence: work.fence, leaseTokenHash: hashToken(work.leaseToken) }
    const limits = { maxModelCalls: 4, maxTokens: 1000, maxCostMicros: 1000, reservedTokens: 20,
      deadlineAt: new Date(Date.now() + 60_000).toISOString() }
    await new PgModelBudgetStore(pool, memory.admit).reserve(id, 'synthetic-call', limits, proof)
    const held = gate(), resume = gate(), connected = gate(), databaseErrors = []
    let reviewPid, admissionPid, reviewPaused = false
    const wrapped = review => ({ query: (sql, params) => pool.query(sql, params), async connect() {
      const client = await pool.connect()
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      if (review) reviewPid = pid; else { admissionPid = pid; connected.resolve() }
      return { async query(sql, params) {
        try {
          const result = await client.query(sql, params)
          if (review && scopeLock(sql) && !reviewPaused) { reviewPaused = true; held.resolve(); await resume.promise }
          return result
        } catch (error) { databaseErrors.push(error.code); throw error }
      }, release: () => client.release() }
    } })
    const reviewRuntime = createMemoryRuntime(wrapped(true), options)
    const admissionPool = wrapped(false), admissionRuntime = createMemoryRuntime(admissionPool, options)
    const action = { runId: id, cellId: 'synthetic-review', callIndex: 0,
      idempotencyKey: JSON.stringify([id, 'synthetic-review', 0]), action: 'memory.apply', args: {
        scopeType: 'user', scopeId: 'human', changes: [{ action: 'create', content: {
          path: 'synthetic.md', title: 'Synthetic', description: 'Fixture preference', body: 'Use diagrams.', layer: 'reference',
        } }],
      } }
    let review, admission
    try {
      review = reviewRuntime.prepareReview(work, action)
      // Install rejection observers immediately; the final assertion still fails.
      void review.catch(() => {})
      await Promise.race([held.promise, delay(5000).then(() => { throw Error('review did not acquire its real scope lock') })])
      admission = boundary === 'model'
        ? new PgModelBudgetStore(admissionPool, admissionRuntime.admit).reserve(id, 'synthetic-call', { ...limits, memoryAdmission: true }, proof)
        : admissionRuntime.context(work)
      void admission.catch(() => {})
      await Promise.race([connected.promise, delay(5000).then(() => { throw Error('admission did not connect') })])
      assert.notEqual(reviewPid, admissionPid)
      const deadline = Date.now() + 5000
      while (true) {
        const blocked = (await pool.query('SELECT pg_blocking_pids($1) AS pids', [admissionPid])).rows[0].pids
        if (blocked.includes(reviewPid)) break
        assert.ok(Date.now() < deadline, 'admission must really block behind the review transaction')
        await delay(10)
      }
      // Authorization may be revoked independently while the transaction waits.
      if (mutation === 'revoked') allowed = false
      resume.resolve()
      const results = await Promise.allSettled([review, admission])
      const failures = JSON.stringify(results.map(result => result.status === 'rejected' ? { code: result.reason.code, message: result.reason.message } : { ok: true }))
      assert.equal(databaseErrors.includes('40P01'), false, failures)
      if (mutation === 'none') {
        assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled'], failures)
        assert.ok(results[0].value.hash)
        if (boundary === 'model') assert.equal(results[1].value.allowed, true)
      } else {
        assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected'], failures)
        assert.match(results[0].reason.message, /revoked/)
        assert.match(results[1].reason.message, /revoked/)
      }
      const budget = (await pool.query('SELECT model_calls::int AS calls FROM lingxios.agent_model_budgets WHERE root_work_id=$1', [id])).rows[0]
      assert.equal(budget.calls, 1, 'final admission does not reserve another provider call')
      if (boundary === 'model' && mutation === 'none') {
        await assert.rejects(memory.prepareReview({ ...work, fence: work.fence + 1 }, action), /current worker lease/)
        const prepared = await memory.prepareReview(work, action)
        await store.addSteer(id, 'A different synthetic preference.')
        const revisions = (await pool.query('SELECT steer_inputs FROM lingxios.agent_work_items WHERE id=$1', [id])).rows[0].steer_inputs
        await pool.query('UPDATE lingxios.agent_os_sessions SET request_snapshot=$2::jsonb WHERE session_key=$1',
          [sessionKeyOf(work), JSON.stringify({ ...request, revisions })])
        await assert.rejects(memory.recordReview(work, action, prepared.hash, { approved: true, explicit: true, confidence: 1 }), /superseded/)
        assert.equal((await memory.prepareReview(work, action)).requestVersion, 2)
        await memory.api.forget({ tenantId, agentId: 'agent', principalId: 'human', sessionId }, scope)
        await assert.rejects(memory.prepareReview(work, action), /predates forgetting/)
        await store.requestCancel(id)
        await assert.rejects(memory.prepareReview(work, action), /current worker lease/)
      }
      console.log(`memory admission lock order: ${boundary} + real review / ${mutation} passed`)
    } finally {
      resume.resolve()
      await Promise.allSettled([review, admission].filter(Boolean))
      await pool.query("UPDATE lingxios.agent_work_items SET status='cancelled' WHERE tenant_id=$1", [tenantId])
      await pool.query('DELETE FROM lingxios.agent_os_session_leases WHERE work_id=$1', [id])
    }
  }
}
