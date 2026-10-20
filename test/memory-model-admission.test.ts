import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { it } from 'node:test'
import { memoryFixture, content, identity, scope } from './memory-fixture.js'
import { createMemoryRuntime } from '../src/memory/runtime.js'
import { PgModelBudgetStore, type SqlPool, type SqlQueryable } from '../src/control-plane/pg-store.js'
import { executionModel, DEFAULT_MODEL_BUDGET } from '../src/model/execution.js'
import { OpenAIChatDriver } from '../src/model/openai.js'
import type { WorkItem } from '../src/protocol/types.js'
import type { ModelDriver } from '../src/model/driver.js'
import type { HostPort } from '../src/host/port.js'
import { limitModel } from '../src/model/quota.js'
import { ResourceQuota } from '../src/resource-quota.js'
import { AgentRuntime } from '../src/runtime/runtime.js'
import { durableProtocol } from './protocol-fixture.js'

// See the pre-implementation failure inventory. Reflect preserves a runnable red
// against the old constructors before their additive optional hooks exist.
it('rejects an inventory snapshot when forgetting commits before context returns', async () => {
  const f = await memoryFixture({ contextBudget: { optionalRecall: true }, resolveScopes: async () => [{ ...scope, continuity: 'principal' }] })
  try {
    const { work } = await f.source({ capture: false }), actor = { ...identity, sessionId: work.sessionId, workId: work.id }
    const stable = (await f.api.scopes(actor))[0]!
    await f.api.initialize(actor, { scope: stable, documents: [content('SYNTHETIC_FORGOTTEN_CONTEXT', 'core.md', 'core')], sourceRef: 'settings', idempotencyKey: 'seed' })
    let entered!: () => void, resume!: () => void, gated = false
    const waiting = new Promise<void>(r => { entered = r }), release = new Promise<void>(r => { resume = r })
    const query: SqlPool['query'] = async (sql, params) => {
      const result = await f.pool.query(sql, params)
      if (!gated && sql.includes('jsonb_agg(core)')) { gated = true; entered(); await release }
      return result
    }
    const memory = createMemoryRuntime({ query, connect: async () => ({ query, release() {} }) }, f.options)
    const pending = memory.context(work)
    await waiting; await f.api.forget(actor, stable); resume()
    await assert.rejects(pending, /forgotten|epoch/i)
  } finally { await f.close() }
})

for (const boundary of ['request-event', 'publication-gate', 'retry', 'quota-queue', 'nested-quota-queue'] as const) it(`fences forget at the ${boundary} boundary before the next scripted provider call`, async () => {
  let publicationWork: Promise<void> | undefined
  const f = await memoryFixture({ contextBudget: { optionalRecall: true }, resolveScopes: async () => [{ ...scope, continuity: 'principal' }] })
  try {
    const { work } = await f.source({ leased: true, capture: false }), actor = { ...identity, sessionId: work.sessionId, workId: work.id }
    const stable = (await f.api.scopes(actor))[0]!
    await f.api.initialize(actor, { scope: stable, documents: [content('SYNTHETIC_PRIVATE_FACT', 'core.md', 'core')], sourceRef: 'settings', idempotencyKey: 'seed' })
    const memory = createMemoryRuntime(f.pool, f.options)
    await memory.context(work)
    const budgets = Reflect.construct(PgModelBudgetStore, [f.pool, (db: SqlQueryable, w: WorkItem) =>
      (memory as unknown as { admit(db: SqlQueryable, work: WorkItem): Promise<void> }).admit(db, w)]) as PgModelBudgetStore
    let providerCalls = 0, settlements = 0, startedEvents = 0, gates = 0, forgotten = false
    const forget = async () => { if (!forgotten) { forgotten = true; await f.api.forget(actor, stable) } }
    const proof = { workId: work.id, fence: work.fence, leaseTokenHash: createHash('sha256').update(work.leaseToken).digest('hex') }
    const host: Pick<HostPort, 'reserveModelCall' | 'recordModelUsage'> = {
      reserveModelCall: (_work, id, limits) => budgets.reserve(work.id, id, limits, proof),
      recordModelUsage: async (_work, id, usage, observation) => { settlements++; await budgets.record(work.id, id, usage.inputTokens, usage.outputTokens, usage.costMicros, proof, observation) },
    }
    const driver = new OpenAIChatDriver('synthetic', { apiKey: 'synthetic', maxOutputTokens: 20, fetchImpl: async () => {
      providerCalls++
      if (boundary === 'retry' && providerCalls === 1) { await forget(); return new Response('synthetic timeout', { status: 408 }) }
      return new Response('data: '+JSON.stringify({choices:[{delta:{content:'synthetic'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({usage:{prompt_tokens:4,completion_tokens:2},choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n', {headers:{'content-type':'text/event-stream'}})
    } })
    let releaseQuota!: () => void, enteredQuota!: () => void
    const queued = new Promise<void>(resolve => { enteredQuota = resolve })
    const quota = new ResourceQuota(1), held = boundary.includes('quota-queue') ? quota.run(() => new Promise<void>(resolve => { releaseQuota = resolve })) : undefined
    const run = quota.run.bind(quota)
    if (boundary.includes('quota-queue')) quota.run = (operation, signal, priority) => { const pending = run(operation, signal, priority); enteredQuota(); return pending }
    const model = Reflect.apply(executionModel, undefined, [host, boundary === 'nested-quota-queue' ? limitModel(limitModel(driver, quota), new ResourceQuota(1)) : boundary === 'quota-queue' ? limitModel(driver, quota) : driver, work, DEFAULT_MODEL_BUDGET,
      async (event: { kind: string }) => { if (event.kind === 'model.request.started') { startedEvents++; if (boundary === 'request-event') await forget() } }, 'model', undefined, () => true]) as ModelDriver
    const pending = model.run({ instructions: '', items: [{ role: 'user', content: 'synthetic' }], onAttempt: () => {
      gates++; if (boundary === 'publication-gate') return publicationWork = forget()
    } })
    if (boundary.includes('quota-queue')) { await queued; await forget(); releaseQuota(); await held }
    await assert.rejects(pending, /forgotten|epoch/i)
    assert.equal(providerCalls, boundary === 'retry' ? 1 : 0)
    assert.equal(settlements, boundary === 'retry' ? 2 : 1)
    assert.equal(startedEvents, settlements)
    assert.ok(gates >= 1)
    const rows = (await f.db.query<{ calls: number; settled: number }>(`SELECT count(*)::int AS calls,
      count(input_tokens)::int AS settled FROM lingxios.agent_model_budget_calls`)).rows[0]!
    assert.deepEqual(rows, { calls: settlements, settled: settlements })
    const unstarted = (await f.db.query<{ input_tokens: number; output_tokens: number }>('SELECT input_tokens,output_tokens FROM lingxios.agent_model_budget_calls ORDER BY call_id DESC LIMIT 1')).rows[0]!
    assert.equal(unstarted.input_tokens, 0); assert.equal(unstarted.output_tokens, 0)
  } finally { await publicationWork; await f.close() }
})


it('carries the actual AgentRuntime context proof past model.started before provider dispatch', async () => {
  const f = await memoryFixture({ contextBudget: { optionalRecall: true }, resolveScopes: async () => [{ ...scope, continuity: 'principal' }] })
  try {
    const { work } = await f.source({ leased: true, capture: false }), actor = { ...identity, sessionId: work.sessionId, workId: work.id }
    const stable = (await f.api.scopes(actor))[0]!
    await f.api.initialize(actor, { scope: stable, documents: [content('SYNTHETIC_CONTEXT_FACT','core.md','core')], sourceRef: 'settings', idempotencyKey: 'seed' })
    const memory = createMemoryRuntime(f.pool, f.options), budgets = new PgModelBudgetStore(f.pool, memory.admit)
    const proof = { workId: work.id, fence: work.fence, leaseTokenHash: createHash('sha256').update(work.leaseToken).digest('hex') }
    let modelCalls = 0, settlements = 0, gated = false
    const unexpected = async () => { throw new Error('unexpected synthetic operation') }
    const host: HostPort = { ...durableProtocol(), claimWork: async () => null, heartbeat: async () => ({ ok: true }),
      loadContext: async () => ({work,persona:{name:'Synthetic',role:'assistant',instructions:''},capabilities:[],messages:[{ref:work.triggerRef,authorId:'u',authorName:'Synthetic',authorKind:'human',body:'Hello',createdAt:'now'}],memory:await memory.context(work)}),
      reserveModelCall: (_w,id,limits)=>budgets.reserve(work.id,id,limits,proof),
      recordModelUsage: async (_w,id,usage,observation)=>{settlements++;await budgets.record(work.id,id,usage.inputTokens,usage.outputTokens,usage.costMicros,proof,observation)},
      loadSession: async () => null, saveSession: async () => {}, executeAction: unexpected,
      emitEvent: async (_w,event) => { if(event.kind==='model.started'&&!gated) {gated=true;await f.api.forget(actor,stable)} },
      commitResult: async()=>{},completeWork:async()=>{},yieldWork:async()=>{} }
    const model: ModelDriver = { modelId:'synthetic', structured:unexpected,compact:unexpected,run:async()=>{modelCalls++;return{text:'Hello.',output:[],usage:{available:true,inputTokens:2,outputTokens:1}}} }
    await new AgentRuntime(host,model,{execute:unexpected} as never).runWork(work)
    assert.ok(gated);assert.equal(modelCalls,0);assert.equal(settlements,1)
  } finally { await f.close() }
})

for (const scenario of ['normal','revoked','cancelled-gate','rejected-gate','no-memory'] as const) it(`preserves ${scenario} attempt accounting and current authorization`,async()=>{
  let allowed=true
  const f=await memoryFixture({contextBudget:{optionalRecall:true},resolveScopes:async()=>allowed?[{...scope,continuity:'principal'}]:[]})
  try {
    const {work}=await f.source({leased:true,capture:false}),memory=createMemoryRuntime(f.pool,f.options)
    if(scenario!=='no-memory') await memory.context(work)
    const budgets=new PgModelBudgetStore(f.pool,memory.admit),proof={workId:work.id,fence:work.fence,leaseTokenHash:createHash('sha256').update(work.leaseToken).digest('hex')}
    let reserves=0,settlements=0,providers=0
    const host: Pick<HostPort,'reserveModelCall'|'recordModelUsage'>={
      reserveModelCall:(_w,id,limits)=>{reserves++;return budgets.reserve(work.id,id,limits,proof)},
      recordModelUsage:async(_w,id,usage,observation)=>{settlements++;await budgets.record(work.id,id,usage.inputTokens,usage.outputTokens,usage.costMicros,proof,observation)},
    }
    const unexpected=async()=>{throw new Error('unexpected')}
    const source:ModelDriver={modelId:'scripted',structured:unexpected,compact:unexpected,run:async()=>{providers++;return{text:'ok',output:[],usage:{available:true,inputTokens:2,outputTokens:1}}}}
    const controller=new AbortController()
    const model=executionModel(host,source,work,DEFAULT_MODEL_BUDGET,undefined,'model',undefined,()=>scenario!=='no-memory')
    const pending=model.run({instructions:'',items:[],signal:controller.signal,onAttempt:async()=>{
      if(scenario==='revoked')allowed=false
      if(scenario==='cancelled-gate')controller.abort(new Error('synthetic cancellation'))
      if(scenario==='rejected-gate')throw new Error('synthetic publication rejection')
    }})
    if(scenario==='normal'||scenario==='no-memory')await pending
    else await assert.rejects(pending,/revoked|cancellation|publication/)
    assert.equal(providers,scenario==='normal'||scenario==='no-memory'?1:0)
    assert.equal(settlements,1)
    assert.equal(reserves,scenario==='normal'||scenario==='revoked'?2:1)
    const row=(await f.db.query<{calls:number;tokens:number}>('SELECT model_calls::int AS calls,tokens::int FROM lingxios.agent_model_budgets')).rows[0]!
    assert.equal(row.calls,1);assert.equal(row.tokens,providers?3:0)
  }finally{await f.close()}
})

it('uses only server-recorded epochs and never charges a forged final admission',async()=>{
  const f=await memoryFixture({contextBudget:{optionalRecall:true},resolveScopes:async()=>[{...scope,continuity:'principal'}]})
  try{
    const {work}=await f.source({leased:true,capture:false}),actor={...identity,sessionId:work.sessionId,workId:work.id}
    const memory=createMemoryRuntime(f.pool,f.options),stable=(await f.api.scopes(actor))[0]!
    await memory.context(work)
    const budgets=new PgModelBudgetStore(f.pool,memory.admit),proof={workId:work.id,fence:work.fence,leaseTokenHash:createHash('sha256').update(work.leaseToken).digest('hex')}
    const limits={maxModelCalls:10,maxTokens:1000,maxCostMicros:1000,reservedTokens:10,reservedCostMicros:10,deadlineAt:new Date(Date.now()+60000).toISOString()}
    await assert.rejects(budgets.reserve(work.id,'never-reserved',{...limits,memoryAdmission:true},proof),/unsettled reservation/)
    assert.equal((await f.db.query<{n:number}>('SELECT count(*)::int AS n FROM lingxios.agent_model_budgets')).rows[0]!.n,0)
    await budgets.reserve(work.id,'reserved',limits,proof)
    await f.api.forget(actor,stable)
    const forged={...limits,memoryAdmission:true as const,memoryEpochs:[{...stable,epoch:1}],memoryProof:{epochs:[]}}
    await assert.rejects(budgets.reserve(work.id,'reserved',forged,proof),/forgotten/)
    await assert.rejects(memory.context(work),/forgotten/)
    const row=(await f.db.query<{calls:number;tokens:number}>('SELECT model_calls::int AS calls,tokens::int FROM lingxios.agent_model_budgets')).rows[0]!
    assert.deepEqual(row,{calls:1,tokens:10})
  }finally{await f.close()}
})

it('defines already-admitted calls without resurrecting forgotten memory or admitting a later attempt',async()=>{
  const f=await memoryFixture({contextBudget:{optionalRecall:true},resolveScopes:async()=>[{...scope,continuity:'principal'}]})
  try{
    const {work,message}=await f.source({leased:true,capture:false}),actor={...identity,sessionId:work.sessionId,workId:work.id}
    const memory=createMemoryRuntime(f.pool,f.options),stable=(await f.api.scopes(actor))[0]!
    await f.api.initialize(actor,{scope:stable,documents:[content('SYNTHETIC_MEMORY')],sourceRef:'settings',idempotencyKey:'seed'})
    await memory.context(work)
    const budgets=new PgModelBudgetStore(f.pool,memory.admit),proof={workId:work.id,fence:work.fence,leaseTokenHash:createHash('sha256').update(work.leaseToken).digest('hex')}
    let calls=0,settlements=0
    const host:Pick<HostPort,'reserveModelCall'|'recordModelUsage'>={reserveModelCall:(_w,id,limits)=>budgets.reserve(work.id,id,limits,proof),
      recordModelUsage:async(_w,id,usage,observation)=>{settlements++;await budgets.record(work.id,id,usage.inputTokens,usage.outputTokens,usage.costMicros,proof,observation)}}
    const unexpected=async()=>{throw new Error('unexpected')}
    const model=executionModel(host,{modelId:'scripted',structured:unexpected,compact:unexpected,run:async()=>{
      calls++;await f.api.forget(actor,stable)
      return{text:'already admitted result',output:[],usage:{available:true,inputTokens:2,outputTokens:1}}
    }},work,DEFAULT_MODEL_BUDGET,undefined,'model',undefined,()=>true)
    assert.equal((await model.run({instructions:'',items:[]})).text,'already admitted result')
    const {captureMemoryEvidence}=await import('../src/memory/evidence.js')
    await captureMemoryEvidence(f.pool,work,message,[stable])
    assert.equal((await f.db.query<{n:number}>('SELECT count(*)::int AS n FROM lingxios.agent_memories')).rows[0]!.n,0)
    assert.equal((await f.db.query<{n:number}>('SELECT count(*)::int AS n FROM lingxios.agent_memory_evidence_scopes')).rows[0]!.n,0)
    await assert.rejects(model.run({instructions:'',items:[]}),/forgotten/)
    assert.equal(calls,1);assert.equal(settlements,2)
  }finally{await f.close()}
})
