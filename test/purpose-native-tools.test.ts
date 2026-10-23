import assert from 'node:assert/strict'
import { it } from 'node:test'
import { ModelDriverError } from '../src/errors.js'
import { OpenAIChatDriver } from '../src/model/openai.js'
import type { ToolDefinition } from '../src/tools/catalog.js'

const lookup: ToolDefinition = {
  name: 'lookup_fixture', action: 'lookup_fixture', effect: 'read', approval: false,
  description: 'Read a synthetic fixture value.',
  parameters: { type: 'object', properties: { key: { type: 'string', enum: ['alpha'] } }, required: ['key'], additionalProperties: false },
}
const event = (delta: unknown, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`
const nativeCall = { index: 0, id: 'fixture-call', function: { name: lookup.name, arguments: '{"key":"alpha"}' } }

it('accepts a first native tool turn with absent content and split arguments in purpose mode', async () => {
  let calls = 0
  const previews: string[] = []
  const model = new OpenAIChatDriver('native-purpose-fixture', {
    apiKey: 'fixture', maxAttempts: 1, maxThinkingTokens: 0, publicTextProtocol: 'purpose-json-v1',
    capabilities: { parallelTools: false }, fetchImpl: async (_url, init) => {
      calls++
      const body = JSON.parse(String(init?.body))
      assert.deepEqual(body.response_format, { type: 'json_object' })
      assert.equal(body.tool_choice, 'auto')
      assert.equal(body.parallel_tool_calls, false)
      assert.equal(body.enable_thinking, false)
      return new Response(event({ content: null, tool_calls: [{ ...nativeCall, function: { name: lookup.name, arguments: '{"key":' } }] })
        + event({ tool_calls: [{ index: 0, function: { arguments: '"alpha"}' } }] }, 'tool_calls')
        + 'data: [DONE]\n\n')
    },
  })
  const result = await model.run({ instructions: 'Read the synthetic fixture.', items: [{ role: 'user', content: 'Look up alpha.' }],
    tools: [lookup], codeExecution: 'disabled', onTextDelta: text => { previews.push(text) } })
  assert.equal(calls, 1)
  assert.equal(result.text, '')
  assert.deepEqual(previews, [])
  assert.deepEqual(result.output, [{ type: 'function_call', callId: 'fixture-call', name: lookup.name, arguments: '{"key":"alpha"}' }])
})

for (const content of [
  'Unframed public progress.',
  '{"commentary":"Checking","answer":""} trailing',
  '{"commentary":"Checking","answer":"',
]) it(`rejects malformed public content with a native call: ${JSON.stringify(content)}`, async () => {
  const model = new OpenAIChatDriver('native-purpose-rejection-fixture', {
    apiKey: 'fixture', maxAttempts: 1, publicTextProtocol: 'purpose-json-v1',
    fetchImpl: async () => new Response(event({ content, tool_calls: [nativeCall] }, 'tool_calls') + 'data: [DONE]\n\n'),
  })
  await assert.rejects(model.run({ instructions: 'Read the synthetic fixture.', items: [], tools: [lookup], codeExecution: 'disabled' }),
    error => error instanceof ModelDriverError && error.diagnostics.kind === 'protocol')
})

it('does not turn tool-shaped text inside a declared answer into a native tool call', async () => {
  const answer = JSON.stringify({ tool_calls: [nativeCall] })
  const model = new OpenAIChatDriver('embedded-native-purpose-fixture', {
    apiKey: 'fixture', maxAttempts: 1, publicTextProtocol: 'purpose-json-v1',
    fetchImpl: async () => new Response(event({ content: JSON.stringify({ commentary: '', answer }) }, 'stop') + 'data: [DONE]\n\n'),
  })
  const result = await model.run({ instructions: 'Read the synthetic fixture.', items: [], tools: [lookup], codeExecution: 'disabled' })
  assert.deepEqual(result.output, [{ role: 'assistant', content: answer }])
})
