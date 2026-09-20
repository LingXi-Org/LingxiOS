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
