import assert from 'node:assert/strict'
import { it } from 'node:test'
import { Ajv } from 'ajv'
import { TASK_TOOLS, parseTaskArgs } from '../src/tools/catalog.js'
import { OpenAIChatDriver } from '../src/model/openai.js'
import { validateToolBatch } from '../src/runtime/tool-batch.js'

const receipt = TASK_TOOLS.find(tool => tool.action === 'task.check_receipt')!
const resource = TASK_TOOLS.find(tool => tool.action === 'task.check_resource')!

it('explicit task schema forms preserve all JSON receipt values and open resource maps', () => {
  const ajv = new Ajv({ strict: false, allowUnionTypes: true })
  const oldReceipt = structuredClone(receipt.parameters)
  oldReceipt.properties['expected'] = {}
  const oldResource = structuredClone(resource.parameters)
  delete oldResource.properties['args']!['additionalProperties']
  delete oldResource.properties['expected']!['additionalProperties']
  const validators = [receipt.parameters, oldReceipt, resource.parameters, oldResource].map(schema => ajv.compile(schema))
  const values = [null, false, true, 0, -1.5, '', 'text', [], [null, { nested: [1, false] }], {},
    { id: 'synthetic', result: { value: [null, 1] }, state: { revision: 2 } }]
  for (const expected of values) {
    const args = { idempotencyKey: 'synthetic-key', action: 'record.write', expected }
    assert.equal(validators[0]!(args), validators[1]!(args))
    assert.equal(validators[0]!(args), true)
    assert.doesNotThrow(() => parseTaskArgs(receipt.action, args))
  }
  const objectCases = [{}, { anyKey: null }, { arbitrary: { nested: ['text', false, 0] } },
    Object.fromEntries(Array.from({ length: 16 }, (_, i) => ['field' + i, i])),
    Object.fromEntries(Array.from({ length: 17 }, (_, i) => ['field' + i, i]))]
  for (const args of objectCases) for (const expected of objectCases) {
    const input = { action: 'record.read', args, expected }
    assert.equal(validators[2]!(input), validators[3]!(input))
    assert.equal(validators[2]!(input), Object.keys(expected).length >= 1 && Object.keys(expected).length <= 16)
  }
})

it('task verification still rejects conflicting expectations, extra fields and invalid resource fields', () => {
  for (const args of [{}, { expected: undefined }, { expected: 1, expectedSha256: 'a'.repeat(64) }, { expectedSha256: 'invalid' }]) {
    assert.throws(() => validateToolBatch([{ type: 'function_call', callId: 'r', name: receipt.name,
      arguments: JSON.stringify({ idempotencyKey: 'key', action: 'record.write', ...args }) }], [receipt], 'disabled', true))
  }
  for (const args of [{ action: 'record.read', args: {}, expected: {} },
    { action: 'record.read', args: {}, expected: { constructor: 'forbidden' } },
    { action: 'record.read', args: [], expected: { value: 1 } },
    { action: 'record.read', args: {}, expected: { value: 1 }, extra: true }]) {
    assert.throws(() => validateToolBatch([{ type: 'function_call', callId: 'r', name: resource.name,
      arguments: JSON.stringify(args) }], [resource], 'disabled', true))
  }
})

it('required native generation and wire estimates retain both complete task schemas', async () => {
  let sent: Record<string, any> | undefined, estimated: Record<string, any> | undefined
  const model = new OpenAIChatDriver('synthetic-task-schema', { apiKey: 'synthetic', maxAttempts: 1,
    maxThinkingTokens: 0, publicTextProtocol: 'purpose-json-v3', publicTextContinuation: 'typed-message-v1',
    publicAnswerTool: 'native-v3', capabilities: { parallelTools: true, jsonObjectWithTools: false },
    countTokens: value => { if (value.startsWith('{')) estimated = JSON.parse(value); return value.length },
    fetchImpl: async (_, init) => {
      sent = JSON.parse(String(init!.body))
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'synthetic',
        type: 'function', function: { name: 'public_answer', arguments: JSON.stringify({ operation: { kind: 'append', supersedes: [] },
          answer: 'Synthetic answer', outcome: { status: 'satisfied', gaps: [] } }) } }] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n')
    } })
  const request = { instructions: 'Synthetic only', items: [], tools: [receipt, resource], codeExecution: 'disabled' as const }
  model.generationInputTokens(request)
  await model.run(request)
  assert.equal(sent!['tool_choice'], 'required')
  assert.equal(estimated!['tool_choice'], 'required')
  assert.deepEqual(sent!['tools'], estimated!['tools'])
  for (const tool of [receipt, resource]) {
    assert.deepEqual(sent!['tools'].find((item: any) => item.function.name === tool.name).function.parameters, tool.parameters)
  }
})
