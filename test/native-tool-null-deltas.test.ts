import assert from 'node:assert/strict'
import { it } from 'node:test'
import { ModelDriverError } from '../src/errors.js'
import { OpenAIChatDriver } from '../src/model/openai.js'
import type { PublicTextProtocol } from '../src/model/driver.js'
import type { ToolDefinition } from '../src/tools/catalog.js'

const tool: ToolDefinition = { name: 'fixture__read', action: 'fixture.read', effect: 'read', approval: false,
  description: 'Read a synthetic value.', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } }
const call = { index: 0, id: 'fixture-call', type: 'function', function: { name: tool.name, arguments: '{"key":' } }
const frame = (delta: unknown, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`
const usage = 'data: {"choices":[],"usage":{"prompt_tokens":17,"completion_tokens":9}}\n\ndata: [DONE]\n\n'
let sequence = 0
function fixture(wire: string, publicTextProtocol: PublicTextProtocol = 'purpose-json-v3') {
  const seen: unknown[] = []
  const model = new OpenAIChatDriver(`nullable-delta-${++sequence}`, { apiKey: 'synthetic', maxAttempts: 1,
    publicTextProtocol, capabilities: { jsonObjectWithTools: false, parallelTools: false }, fetchImpl: async () => new Response(wire + usage) })
  const run = () => model.run({ instructions: 'Read a synthetic value.', items: [], tools: [tool], codeExecution: 'disabled',
    onTextOperation: value => { seen.push(value) }, onTextDelta: value => { seen.push(value) } })
  return { run, seen }
}

for (const protocol of ['purpose-json-v2', 'purpose-json-v3'] as const) {
  for (const [field, optional] of Object.entries({ id: { id: null }, type: { type: null }, function: { function: null },
    name: { function: { name: null } }, arguments: { function: { arguments: null } },
    combined: { id: null, type: null, function: { name: null, arguments: null } } })) {
    it(`${protocol} retains complete native calls across nullable ${field} deltas`, async () => {
      const { run, seen } = fixture(frame({ content: 'UNPUBLISHED_COMPANION_SENTINEL', tool_calls: [call] })
        + frame({ tool_calls: [{ index: 0, ...optional }] })
        + frame({ tool_calls: [{ index: 0, id: null, type: null, function: { name: null, arguments: '"alpha"}' } }] }, 'tool_calls'), protocol)
      const result = await run()
      assert.deepEqual(result.output, [{ type: 'function_call', callId: call.id, name: tool.name, arguments: '{"key":"alpha"}' }])
      assert.equal(result.text, '')
      assert.equal(result.answerOperation, undefined)
      assert.deepEqual(result.usage, { available: true, inputTokens: 17, outputTokens: 9 })
      assert.deepEqual(seen, [])
      assert.doesNotMatch(JSON.stringify(result), /UNPUBLISHED_COMPANION_SENTINEL/)
    })
  }
}

for (const [name, delta] of Object.entries({
  'null index': { index: null }, 'non-string id': { id: 42 }, 'conflicting id': { id: 'different-call' },
  'invalid type': { type: 'custom' }, 'non-object function': { function: [] },
  'non-string name': { function: { name: 42 } }, 'conflicting name': { function: { name: 'unexposed' } },
  'non-string arguments': { function: { arguments: 42 } },
})) it(`nullable compatibility still rejects ${name}`, async () => {
  const { run, seen } = fixture(frame({ content: 'UNPUBLISHED_COMPANION_SENTINEL', tool_calls: [call] })
    + frame({ tool_calls: [{ index: 0, ...delta }] })
    + frame({ tool_calls: [{ index: 0, function: { arguments: '"alpha"}' } }] }, 'tool_calls'))
  await assert.rejects(run(), error => error instanceof ModelDriverError && error.diagnostics.protocolCode === 'tool_identity_invalid')
  assert.deepEqual(seen, [])
})

it('null-only metadata cannot invent a complete tool identity', async () => {
  const { run } = fixture(frame({ content: 'UNPUBLISHED_COMPANION_SENTINEL',
    tool_calls: [{ index: 0, id: null, type: null, function: { name: null, arguments: '{}' } }] }, 'tool_calls'))
  await assert.rejects(run(), error => error instanceof ModelDriverError && error.diagnostics.protocolCode === 'tool_identity_invalid')
})

it('typed v3 answer and native call still retain their distinct purposes across nullable fragments', async () => {
  const operation = { kind: 'append', supersedes: [] }
  const content = JSON.stringify({ operation, commentary: '', answer: 'Useful public text. ', outcome: null })
  const { run, seen } = fixture(frame({ content, tool_calls: [call] })
    + frame({ tool_calls: [{ index: 0, id: null, type: null, function: { name: null, arguments: '"alpha"}' } }] }, 'tool_calls'))
  const result = await run()
  assert.equal(result.text, 'Useful public text. ')
  assert.deepEqual(result.answerOperation, operation)
  assert.deepEqual(seen, [operation, 'Useful public text. '])
  assert.equal(result.output.length, 2)
})
