import assert from 'node:assert/strict'
import { it } from 'node:test'
import { executionModel, DEFAULT_MODEL_BUDGET, type ModelCallObservation } from '../src/model/execution.js'
import type { ModelDriver } from '../src/model/driver.js'
import type { WorkItem } from '../src/protocol/types.js'

// Safe operation enums must originate at the invocation, survive settlement,
// and never be inferred from prompt contents or accept arbitrary strings.
it('records actual generation, correction and auxiliary operations without changing API accounting', async () => {
  const observations: ModelCallObservation[] = [], events: Array<Record<string, unknown>> = []
  const usage = { available: true, inputTokens: 2, outputTokens: 1 }
  const source: ModelDriver = { modelId: 'fixture', maxOutputTokens: 10,
    run: async () => ({ text: 'Done.', output: [], usage }),
    structured: async () => ({ value: {}, model: 'fixture', usage }), compact: async () => ({ value: '{}', model: 'fixture', usage }) }
  const model = executionModel({ reserveModelCall: async () => ({ allowed: true, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    remainingCalls: 20, remainingTokens: 10000, remainingCostMicros: 10000 }),
    recordModelUsage: async (_work, _id, _usage, observation) => { observations.push(observation!) } },
  source, { id: 'operation', tenantId: 't', agentId: 'a', sessionId: 's', fence: 1 } as WorkItem, DEFAULT_MODEL_BUDGET,
  async event => { events.push(event.data) })
  await model.run({ instructions: 'PRIVATE_content-review', items: [] })
  await model.run({ instructions: '', items: [], operation: 'correction' } as Parameters<ModelDriver['run']>[0])
  for (const purpose of ['content-review', 'memory-synthesis', 'approval-explanation'] as const) await model.structured({ instructions: '', input: {}, purpose })
  await model.structured({ instructions: 'content-review', input: {} })
  await model.compact({ instructions: '', items: [] })
  const operations = observations.map(item => Reflect.get(item, 'operation'))
  assert.deepEqual(operations, ['generation', 'correction', 'content-review', 'memory-synthesis', 'approval-explanation', 'structured', 'compaction'])
  assert.deepEqual(observations.map(item => item.purpose), ['agent-turn', 'agent-turn', 'structured', 'structured', 'structured', 'structured', 'compaction'])
  assert.deepEqual(events.map(item => item['operation']), operations.flatMap(item => [item, item]))
  assert.equal(observations.length, 7)
  assert.doesNotMatch(JSON.stringify(observations), /PRIVATE_content-review/)
})
