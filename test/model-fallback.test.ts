import assert from 'node:assert/strict'
import { it } from 'node:test'
import { ModelDriverError } from '../src/errors.js'
import { executionModel, DEFAULT_MODEL_BUDGET, type ModelCallObservation } from '../src/model/execution.js'
import type { ModelDriver } from '../src/model/driver.js'
import type { WorkItem } from '../src/protocol/types.js'

const work = { id: 'fallback-work',fence: 1,tenantId: 'tenant',agentId: 'agent',sessionId: 'session',principalId: 'human' } as WorkItem
const pricing = { inputCostMicrosPerMillion: 1000000,outputCostMicrosPerMillion: 2000000 }
function driver(id: string, invoke: () => Promise<void>, attempts = 3): ModelDriver {
  const usage = { available: true,inputTokens: 10,outputTokens: 2 }
  return { modelId: id,recovery: { maxAttempts: attempts,totalTimeoutMs: 1000 },maxOutputTokens: 10,
    profile: { id,contextWindowTokens: 10000,maxOutputTokens: 10,maxThinkingTokens: 0,toolCalls: true,jsonObject: true,parallelTools: true },
    singleAttempt() { return this },
    run: async () => { await invoke(); return { text: 'answer',output: [],model: id,usage } },
    structured: async () => { await invoke(); return { value: {},model: id,usage } },
    compact: async () => { await invoke(); return { value: 'summary',model: id,usage } } }
}
function fixture(primary: ModelDriver, fallback: Parameters<typeof executionModel>[6]) {
  const observations: ModelCallObservation[] = [], reservations: string[] = []
  const model = executionModel({ reserveModelCall: async (_work,id) => { reservations.push(id); return {
    allowed: true,deadlineAt: new Date(Date.now()+5000).toISOString(),remainingCalls: 10,remainingTokens: 100000,remainingCostMicros: 1000000 } },
    recordModelUsage: async (_work,_id,_usage,observation) => { observations.push(observation!) },
  },primary,work,{ ...DEFAULT_MODEL_BUDGET,...pricing },undefined,'model',fallback)
  return { model,observations,reservations }
}

it('switches only after current authorization and accounts both providers inside one logical attempt budget', async () => {
  let calls = 0,authorized = 0
  const primary = driver('primary',async () => { calls++; throw new ModelDriverError('safe',{ status: 402,finishReasons: [] }) })
  const fallback = driver('approved',async () => { calls++ })
  const { model,observations,reservations } = fixture(primary,{ model: fallback,...pricing,
    authorize: async ({ work: current,purpose }) => { assert.equal(current.tenantId,'tenant'); assert.equal(purpose,'agent-turn'); authorized++ } })
  assert.equal((await model.run({ instructions: '',items: [] })).model,'approved')
  assert.equal(calls,2); assert.equal(authorized,1); assert.equal(reservations.length,2)
  assert.deepEqual(observations.map(item => [item.model,item.status,item.attempt]),[['primary','failed',1],['approved','succeeded',2]])
  assert.equal(observations[1]!.logicalCallId,observations[0]!.callId)
  assert.equal(observations[1]!.cost?.amountMicros,14)
})

it('does not reset attempts, bypass authorization, mix prices, or switch after cancellation/protocol failures', async () => {
  for (const mode of ['denied','attempts','cancelled','protocol','pricing','capability','unavailable'] as const) {
    let secondaryCalls = 0
    const controller = new AbortController()
    const primary = driver('primary',async () => {
      if (mode === 'cancelled') { controller.abort(); throw controller.signal.reason }
      throw new ModelDriverError('safe',{
        ...(mode === 'protocol' ? { kind: 'protocol' as const } : { status: 402 }),finishReasons: [] })
    },mode === 'attempts' ? 1 : 3)
    const secondary = driver('secondary',async () => { secondaryCalls++ })
    if (mode === 'capability') secondary.profile!.toolCalls = false
    const execute = async () => {
      const { model } = fixture(primary,mode === 'unavailable' ? undefined : { model: secondary,...pricing,
        outputCostMicrosPerMillion: mode === 'pricing' ? 3 : pricing.outputCostMicrosPerMillion,
        authorize: async () => { if (mode === 'denied') throw new Error('route revoked') } })
      await model.run({ instructions: '',items: [],signal: controller.signal })
    }
    await assert.rejects(execute)
    assert.equal(secondaryCalls,0,mode)
  }
})
