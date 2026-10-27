import assert from 'node:assert/strict'
import { it } from 'node:test'
import { OpenAIChatDriver } from '../src/model/openai.js'
import type { OpenAIDriverOptions } from '../src/model/openai.js'
import type { ToolDefinition } from '../src/tools/catalog.js'
const tools: ToolDefinition[] = [{ name: 'record__read', action: 'record.read', effect: 'read', approval: false,
  description: 'Read a synthetic record.', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } }]
const args = JSON.stringify({ operation: { kind: 'append', supersedes: [] }, commentary: 'I will read both records.', answer: 'TCP preserves order; UDP sends independent datagrams. ', outcome: null })
const call = (index: number, name: string, arguments_: string, id = String(index)) => ({ index, id, type: 'function', function: { name, arguments: arguments_ } })
const publicCall = call(0, 'public_answer', args)
const read = (index: number) => call(index, 'record__read', JSON.stringify({ key: String(index) }))
function fixture(calls: unknown[]) {
  const wire = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Private reasoning stays private.', tool_calls: calls }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`
  const options = { apiKey: 'synthetic', maxAttempts: 1, publicTextProtocol: 'purpose-json-v3', publicTextContinuation: 'typed-message-v1',
    publicAnswerTool: 'native-v2', capabilities: { jsonObjectWithTools: false, parallelTools: true }, fetchImpl: async () => new Response(wire) } as OpenAIDriverOptions
  return new OpenAIChatDriver('round-fixture', options)
}
it('streams public text and returns two independent business calls in one generation', async () => {
  let seen = ''
  const model = fixture([publicCall, read(1), read(2)])
  const result = await model.run({ instructions: 'Use synthetic facts.', items: [], tools, codeExecution: 'disabled', onTextDelta: (text, meta) => { if (meta?.purpose === 'answer') seen += text } })
  assert.equal(seen, 'TCP preserves order; UDP sends independent datagrams. ')
  assert.equal(result.publicTextPhase, 'intermediate')
  assert.equal(result.output.length, 2)
  assert.deepEqual(result.output.map(item => 'type' in item && item.type === 'function_call' ? item.callId : null), ['1', '2'])
  assert.equal(result.publicAnswerCall?.callId, '0')
  assert.doesNotMatch(JSON.stringify(result), /Private reasoning/)
  assert.equal(model.singleAttempt().publicAnswerTool, 'native-v2')
})
for (const [name, calls] of Object.entries({
  'missing public text': [read(0)],
  'business before public': [read(0), call(1, 'public_answer', args)],
  'duplicate public': [publicCall, call(1, 'public_answer', args)],
  'duplicate identity': [publicCall, call(1, 'record__read', '{"key":"a"}', '0')],
  'invalid business schema': [publicCall, call(1, 'record__read', '{"secret":"no"}')],
  'terminal with tools': [call(0, 'public_answer', args.replace('"outcome":null', '"outcome":{"status":"satisfied","gaps":[]}')), read(1)],
})) it(`rejects complete mixed batch: ${name}`, async () => {
  await assert.rejects(fixture(calls).run({ instructions: '', items: [], tools, codeExecution: 'disabled' }))
})
