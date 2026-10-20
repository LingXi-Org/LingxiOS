import assert from 'node:assert/strict'
import { it } from 'node:test'
import { modelExecution, DEFAULT_MODEL_BUDGET, type ModelCallObservation } from '../src/model/execution.js'
import type { WorkItem } from '../src/protocol/types.js'

it('settles a successful model call with nonnegative latency after the system clock moves backward', async t => {
  const now = Date.now(), observations: ModelCallObservation[] = []
  const work = { id: 'work', fence: 1, tenantId: 'tenant', agentId: 'agent', sessionId: 'session', principalId: 'human' } as WorkItem
  const execution = modelExecution({
    reserveModelCall: async () => ({ allowed: true, deadlineAt: new Date(now + 60000).toISOString(),
      remainingCalls: 10, remainingTokens: 100000, remainingCostMicros: 1000000 }),
    recordModelUsage: async (_work, _callId, _usage, observation) => { observations.push(observation!) },
  }, { modelId: 'fixture' }, work, DEFAULT_MODEL_BUDGET)
  const result = { model: 'fixture', usage: { available: true, inputTokens: 1, outputTokens: 1 } }
  await execution.invoke('structured', {}, async () => {
    t.mock.method(Date, 'now', () => now - 5000)
    return result
  })
  assert.equal(observations.length, 1)
  assert.equal(observations[0]!.status, 'succeeded')
  assert.ok(Number.isFinite(observations[0]!.latencyMs) && observations[0]!.latencyMs >= 0)
})

it('retries HTTP 408 inside the runtime boundary and keeps sanitized provider diagnostics', async () => {
  const { OpenAIChatDriver } = await import('../src/model/openai.js')
  const { executionModel } = await import('../src/model/execution.js')
  const observations: ModelCallObservation[] = []
  let requests = 0, reservations = 0
  const model = executionModel({
    reserveModelCall: async () => { reservations++; return { allowed: true, deadlineAt: new Date(Date.now() + 5000).toISOString(),
      remainingCalls: 10, remainingTokens: 100000, remainingCostMicros: 1000000 } },
    recordModelUsage: async (_work, _callId, _usage, observation) => { observations.push(observation!) },
  }, new OpenAIChatDriver('http408', { apiKey: 'private-key', maxOutputTokens: 10, fetchImpl: async () => {
    requests++
    if (requests < 3) return new Response('PRIVATE_PROVIDER_BODY', { status: 408, headers: { 'x-request-id': 'request-408' } })
    return Response.json({ usage: { prompt_tokens: 3, completion_tokens: 2 }, choices: [{ finish_reason: 'stop', message: { content: '{}' } }] })
  } }), { id: 'retry408', fence: 1, tenantId: 'tenant', agentId: 'agent', sessionId: 'session' } as WorkItem, DEFAULT_MODEL_BUDGET)
  await model.structured({ instructions: 'PRIVATE_PROMPT', input: {} })
  assert.equal(requests, 3); assert.equal(reservations, 3); assert.equal(observations.length, 3)
  const diagnostic = observations[0] as unknown as { failure: { category: string; status: number; requestId: string }; attempt: number }
  assert.equal(diagnostic.failure.category, 'timeout')
  assert.equal(diagnostic.failure.status, 408)
  assert.equal(diagnostic.failure.requestId, 'request-408')
  assert.equal(diagnostic.attempt, 1)
  assert.doesNotMatch(JSON.stringify(observations), /PRIVATE_|private-key/)
})

it('preserves rejection metadata without retrying or logging provider bodies', async () => {
  const { OpenAIChatDriver } = await import('../src/model/openai.js')
  const { executionModel } = await import('../src/model/execution.js')
  let requests = 0
  const observations: ModelCallObservation[] = []
  const model = executionModel({
    reserveModelCall: async () => ({ allowed: true, deadlineAt: new Date(Date.now() + 5000).toISOString(),
      remainingCalls: 10, remainingTokens: 100000, remainingCostMicros: 1000000 }),
    recordModelUsage: async (_work, _id, _usage, observation) => { observations.push(observation!) },
  }, new OpenAIChatDriver('http402', { apiKey: 'private-key', maxOutputTokens: 10, fetchImpl: async () => {
    requests++; return new Response('{"error":{"code":"PRIVATE_SECRET","message":"PRIVATE_BODY"}}', {
      status: 402, headers: { 'x-request-id': 'request-402' },
    })
  } }), { id: 'quota', fence: 1, tenantId: 'tenant', agentId: 'agent', sessionId: 'session' } as WorkItem, DEFAULT_MODEL_BUDGET)
  await assert.rejects(model.structured({ instructions: '', input: {} }))
  assert.equal(requests, 1)
  const failure = (observations[0] as unknown as { failure: { category: string; status: number; requestId: string } }).failure
  assert.equal(failure.category, 'quota')
  assert.equal(failure.status, 402)
  assert.equal(failure.requestId, 'request-402')
  assert.doesNotMatch(JSON.stringify(observations), /PRIVATE_|private-key/)
})

// Failure inventory: outer deadline loses provider classification, budget expiry
// looks like a generic failure, or cancellation is rewritten and triggers retry.
it('retains typed total-model and root-budget deadlines after settling the one issued attempt', async () => {
  const { ModelDriverError, ModelBudgetExceededError } = await import('../src/errors.js')
  for (const reason of ['provider', 'root', 'local-root', 'caller'] as const) {
    const observations: ModelCallObservation[] = []
    let calls = 0, settled = 0
    const caller = new AbortController(), cancellation = new Error('caller stopped')
    const execution = modelExecution({
      reserveModelCall: async () => ({ allowed: true, deadlineAt: new Date(Date.now() + (reason === 'root' ? 30 : 5000)).toISOString(),
        remainingCalls: 10, remainingTokens: 100000, remainingCostMicros: 1000000 }),
      recordModelUsage: async (_work, _id, _usage, observation) => { settled++; observations.push(observation!) },
    }, { modelId: 'deadline-fixture', recovery: { maxAttempts: 3, totalTimeoutMs: reason === 'provider' ? 30 : 1000 } },
    { id: 'deadline', fence: 1, tenantId: 'tenant', agentId: 'agent', sessionId: 'session' } as WorkItem, { ...DEFAULT_MODEL_BUDGET, ...(reason === 'local-root' ? { wallClockMs: 30 } : {}) })
    const alive = setTimeout(() => {}, 2000)
    try {
      await assert.rejects(execution.invoke('structured', { signal: caller.signal }, async signal => {
        calls++
        if (reason === 'caller') caller.abort(cancellation)
        return new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason)
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }), error => reason === 'caller' ? error === cancellation : (reason === 'root' || reason === 'local-root')
        ? error instanceof ModelBudgetExceededError && error.diagnostics.dimension === 'deadline'
        : error instanceof ModelDriverError && error.diagnostics.category === 'timeout')
      assert.equal(calls, 1); assert.equal(settled, 1)
      assert.equal(observations[0]?.failure?.category, reason === 'caller' ? 'cancelled' : 'timeout')
    } finally { clearTimeout(alive) }
  }
})

it('keeps the first model deadline when durable settlement outlives the root deadline', async () => {
  const { ModelDriverError } = await import('../src/errors.js')
  const execution = modelExecution({
    reserveModelCall: async () => ({ allowed: true, deadlineAt: new Date(Date.now() + 70).toISOString(),
      remainingCalls: 10, remainingTokens: 100000, remainingCostMicros: 1000000 }),
    recordModelUsage: async () => { await new Promise(resolve => setTimeout(resolve, 100)) },
  }, { modelId: 'settlement-order', recovery: { maxAttempts: 3, totalTimeoutMs: 20 } },
  { id: 'settlement-order', fence: 1, tenantId: 'tenant', agentId: 'agent', sessionId: 'session' } as WorkItem, DEFAULT_MODEL_BUDGET)
  const alive = setTimeout(() => {}, 2000)
  try {
    await assert.rejects(execution.invoke('structured', {}, async signal => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })), error => error instanceof ModelDriverError && error.diagnostics.category === 'timeout')
  } finally { clearTimeout(alive) }
})

it('awaits an async attempt gate without starting the provider after caller cancellation',async()=>{
  const { executionModel }=await import('../src/model/execution.js')
  let release!:()=>void,entered!:()=>void,wire=0,settled=0
  const gate=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
  const stop=new AbortController()
  const model=executionModel({reserveModelCall:async()=>({allowed:true,deadlineAt:new Date(Date.now()+5000).toISOString(),remainingCalls:10,remainingTokens:100000,remainingCostMicros:1000000}),
    recordModelUsage:async()=>{settled++}}, {
    run:async()=>{wire++;return {text:'safe',output:[],usage:{available:true,inputTokens:9,outputTokens:2}}},
    structured:async()=>{throw new Error('unused')},compact:async()=>{throw new Error('unused')},
  },{id:'attempt-gate',fence:1,tenantId:'tenant',agentId:'agent',sessionId:'room'} as WorkItem,DEFAULT_MODEL_BUDGET)
  const pending=model.run({instructions:'',items:[],signal:stop.signal,onAttempt:()=>{entered();return gate}})
  await started;assert.equal(wire,0)
  stop.abort(new Error('synthetic caller cancellation'))
  await assert.rejects(pending,/synthetic caller cancellation/)
  assert.equal(settled,1)
  release();await new Promise<void>(resolve=>setImmediate(resolve))
  assert.equal(wire,0,'a cancelled async gate must not start a late provider request')
  await model.run({instructions:'',items:[]})
  assert.equal(wire,1);assert.equal(settled,2)
})

it('does not retry or start a provider when an async attempt publication gate rejects',async()=>{
  const { executionModel }=await import('../src/model/execution.js')
  const { PublicTextPublicationError }=await import('../src/runtime/public-text.js')
  let wire=0,reserved=0,settled=0,attempts=0
  const failure=new PublicTextPublicationError(),observations:ModelCallObservation[]=[]
  const model=executionModel({reserveModelCall:async()=>{reserved++;return {allowed:true,deadlineAt:new Date(Date.now()+5000).toISOString(),remainingCalls:10,remainingTokens:100000,remainingCostMicros:1000000}},
    recordModelUsage:async(_work,_id,_usage,observation)=>{settled++;observations.push(observation!)}}, {
    run:async()=>{wire++;return {text:'safe',output:[],usage:{available:true,inputTokens:9,outputTokens:2}}},
    structured:async()=>{throw new Error('unused')},compact:async()=>{throw new Error('unused')},
  },{id:'rejected-gate',fence:1,tenantId:'tenant',agentId:'agent',sessionId:'room'} as WorkItem,DEFAULT_MODEL_BUDGET)
  await assert.rejects(model.run({instructions:'',items:[],onAttempt:async()=>{attempts++;await Promise.resolve();throw failure}}),error=>error===failure)
  assert.deepEqual({wire,reserved,settled,attempts},{wire:0,reserved:1,settled:1,attempts:1})
  assert.equal(observations[0]?.failure?.retryable,false)
  await model.run({instructions:'',items:[]})
  assert.deepEqual({wire,reserved,settled},{wire:1,reserved:2,settled:2})
})

it('preserves measured usage when a synchronous attempt hook precedes provider cancellation',async()=>{
  const { executionModel }=await import('../src/model/execution.js')
  const { limitModel }=await import('../src/model/quota.js')
  const { ResourceQuota }=await import('../src/resource-quota.js')
  let wire=0,attempts=0
  const stop=new AbortController(),observations:ModelCallObservation[]=[]
  const model=executionModel({reserveModelCall:async()=>({allowed:true,deadlineAt:new Date(Date.now()+5000).toISOString(),remainingCalls:10,remainingTokens:100000,remainingCostMicros:1000000}),
    recordModelUsage:async(_work,_id,_usage,observation)=>{observations.push(observation!)}},limitModel({
    run:async()=>{wire++;stop.abort();return {text:'safe',output:[],usage:{available:true,inputTokens:9,outputTokens:2}}},
    structured:async()=>{throw new Error('unused')},compact:async()=>{throw new Error('unused')},
  },new ResourceQuota(1)),{id:'synchronous-gate',fence:1,tenantId:'tenant',agentId:'agent',sessionId:'room'} as WorkItem,DEFAULT_MODEL_BUDGET)
  const result=await model.run({instructions:'',items:[],signal:stop.signal,onAttempt:()=>{attempts++}})
  assert.equal(result.text,'safe');assert.equal(stop.signal.aborted,true)
  assert.deepEqual({wire,attempts,settled:observations.length},{wire:1,attempts:1,settled:1})
  assert.deepEqual(observations[0]?.usage,{available:true,inputTokens:9,outputTokens:2})
  assert.equal(observations[0]?.cost?.usage,'measured')
})
