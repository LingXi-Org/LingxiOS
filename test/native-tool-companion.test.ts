import assert from 'node:assert/strict'
import { it } from 'node:test'
import { ModelDriverError } from '../src/errors.js'
import { OpenAIChatDriver, type OpenAIDriverOptions } from '../src/model/openai.js'
import { publicModelDiagnostics } from '../src/model/diagnostics.js'
import { modelProtocolCorrection } from '../src/runtime/protocol-correction.js'
import type { ToolDefinition } from '../src/tools/catalog.js'

const tool: ToolDefinition = { name: 'fixture__read', action: 'fixture.read', effect: 'read', approval: false,
  description: 'Read a synthetic value.', parameters: { type: 'object', properties: {}, additionalProperties: false } }
const call = { index: 0, id: 'fixture-call', type: 'function', function: { name: tool.name, arguments: '{}' } }
const event = (delta: unknown, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`
const usage = 'data: {"choices":[],"usage":{"prompt_tokens":17,"completion_tokens":9}}\n\ndata: [DONE]\n\n'
const request = { instructions: 'Read the synthetic value.', items: [], tools: [tool], codeExecution: 'disabled' as const }
const options: OpenAIDriverOptions = { apiKey: 'synthetic', maxAttempts: 1, publicTextProtocol: 'purpose-json-v2',
  capabilities: { jsonObjectWithTools: false, parallelTools: false } }
const driver = (wire: string, extra: Partial<OpenAIDriverOptions> = {}) =>
  new OpenAIChatDriver('synthetic-native-companion', { ...options, ...extra, fetchImpl: async () => new Response(wire) })

it('changes the opted-out purpose policy fingerprint and preserves it across single-attempt wrappers', () => {
  const model = driver('')
  assert.notEqual(model.configurationFingerprint, '2d34ada75773acda50f8f28e6cdcbf38ae38f3fc7a5e70b801326e25e44b96e7')
  assert.equal(model.singleAttempt().configurationFingerprint, model.configurationFingerprint)
})

it('classifies split whitespace and Unicode prose without exposing its content', async () => {
  const previews: string[] = []
  const result = await driver(event({ content: ' \n' }) + event({ content: '读取合成记录。' })
    + event({ tool_calls: [call] }, 'tool_calls') + usage).run({ ...request, onTextDelta: text => { previews.push(text) } })
  assert.deepEqual(previews, [])
  assert.equal(result.text, '')
  assert.equal(result.output.length, 1)
})

for (const publicTextProtocol of ['purpose-json-v1', 'purpose-json-v2'] as const) {
  it(`${publicTextProtocol}: consumes an untyped tool companion without publishing it or losing its native call/usage`, async () => {
    const previews: string[] = []
    const model = driver(event({ content: 'I will read the synthetic record. ' })
      + event({ content: 'This text has no public purpose.' })
      + event({ tool_calls: [{ ...call, function: { name: tool.name, arguments: '{' } }] })
      + event({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }, 'tool_calls') + usage, { publicTextProtocol })
    const result = await model.run({ ...request, onTextDelta: text => { previews.push(text) } })
    assert.deepEqual(previews, [])
    assert.equal(result.text, '')
    assert.equal(result.outcomeDeclaration, undefined)
    assert.deepEqual(result.output, [{ type: 'function_call', callId: call.id, name: tool.name, arguments: '{}' }])
    assert.deepEqual(result.usage, { available: true, inputTokens: 17, outputTokens: 9 })
    assert.deepEqual(publicModelDiagnostics(result.diagnostics), { finishReasons: ['tool_calls'], publicText: 'unpublished_tool_companion' })
    assert.doesNotMatch(JSON.stringify(result), /I will read|no public purpose/)
  })
}

for (const content of ['{"commentary":"","answer":"visible', '{"commentary":"","answer":"visible","outcome":null} trailing',
  '{"answer":"reordered","commentary":"","outcome":null}', '```json\n{"commentary":"","answer":"","outcome":null}\n```',
  '[{"commentary":"","answer":"","outcome":null}]']) {
  it(`never exempts malformed structured content: ${content.slice(0, 48)}`, async () => {
    const previews: string[] = []
    await assert.rejects(driver(event({ content }, null) + event({ tool_calls: [call] }, 'tool_calls') + usage)
      .run({ ...request, onTextDelta: text => { previews.push(text) } }), ModelDriverError)
    assert.ok(!previews.includes(content))
  })
}

const badTurns: Array<{ name: string; wire: string; parallelTools?: boolean }> = [
  { name: 'no native calls', wire: event({}, 'stop') },
  { name: 'wrong stop reason', wire: event({ tool_calls: [call] }, 'stop') },
  { name: 'truncated response', wire: event({ tool_calls: [call] }, 'length') },
  { name: 'no finish reason', wire: event({ tool_calls: [call] }) },
  { name: 'unknown tool', wire: event({ tool_calls: [{ ...call, function: { name: 'not_exposed', arguments: '{}' } }] }, 'tool_calls') },
  { name: 'empty id', wire: event({ tool_calls: [{ ...call, id: '' }] }, 'tool_calls') },
  { name: 'invalid arguments', wire: event({ tool_calls: [{ ...call, function: { name: tool.name, arguments: '{' } }] }, 'tool_calls') },
  { name: 'non-object arguments', wire: event({ tool_calls: [{ ...call, function: { name: tool.name, arguments: '[]' } }] }, 'tool_calls') },
  { name: 'negative index', wire: event({ tool_calls: [{ ...call, index: -1 }] }, 'tool_calls') },
  { name: 'unknown call type', wire: event({ tool_calls: [{ ...call, type: 'custom' }] }, 'tool_calls') },
  { name: 'changed id at one index', wire: event({ tool_calls: [{ ...call, function: { name: tool.name, arguments: '{' } }] })
    + event({ tool_calls: [{ index: 0, id: 'changed', function: { arguments: '}' } }] }, 'tool_calls') },
  { name: 'duplicate ids across indexes', wire: event({ tool_calls: [call, { ...call, index: 1 }] }, 'tool_calls'), parallelTools: true },
  { name: 'parallel calls disabled', wire: event({ tool_calls: [call, { ...call, index: 1, id: 'second' }] }, 'tool_calls') },
  { name: 'content after terminal reason', wire: event({ tool_calls: [call] }, 'tool_calls') + event({ content: 'Late untyped text.' }) },
  { name: 'repeated terminal reason', wire: event({ tool_calls: [call] }, 'tool_calls') + event({}, 'tool_calls') },
]
for (const content of ['null', 'true', 'false', 'null {"commentary":"","answer":"","outcome":null}']) {
  it(`rejects JSON scalar framing instead of classifying it as prose: ${content}`, async () => {
    const previews: string[] = []
    await assert.rejects(driver([...content].map(character => event({ content: character })).join('')
      + event({ tool_calls: [call] }, 'tool_calls') + usage).run({ ...request, onTextDelta: text => { previews.push(text) } }), error => {
      assert.ok(error instanceof ModelDriverError)
      assert.equal(error.diagnostics.protocolCode, 'public_text_invalid')
      assert.equal(modelProtocolCorrection(error.diagnostics, 'disabled', 'purpose-json-v2').category, 'response_protocol')
      return true
    })
    assert.deepEqual(previews, [])
  })
}
for (const scenario of badTurns) it(`rejects untyped text with ${scenario.name} without publishing or returning a partial call batch`, async () => {
  const previews: string[] = []
  const model = driver(event({ content: 'I will read a synthetic record.' }) + scenario.wire + usage,
    scenario.parallelTools ? { capabilities: { jsonObjectWithTools: false, parallelTools: true } } : {})
  await assert.rejects(model.run({ ...request, onTextDelta: text => { previews.push(text) } }), error => {
    assert.ok(error instanceof ModelDriverError)
    if (scenario.name === 'unknown tool') assert.equal(error.diagnostics.protocolCode, 'tool_identity_invalid')
    assert.deepEqual(error.diagnostics.usage, { available: true, inputTokens: 17, outputTokens: 9 })
    return true
  })
  assert.deepEqual(previews, [])
})

it('accepts every validated parallel native call without exposing the untyped companion', async () => {
  const result = await driver(event({ content: 'Read both synthetic records.', tool_calls: [call, { ...call, index: 1, id: 'second' }] }, 'tool_calls') + usage,
    { capabilities: { jsonObjectWithTools: false, parallelTools: true } }).run(request)
  assert.deepEqual(result.output.map(item => 'callId' in item ? item.callId : null), [call.id, 'second'])
  assert.equal(result.text, '')
})

it('keeps untyped content strict without the explicit incompatible profile or exposed tools', async () => {
  for (const capabilities of [undefined, { jsonObjectWithTools: true }]) {
    await assert.rejects(driver(event({ content: 'I will read.', tool_calls: [call] }, 'tool_calls') + usage,
      capabilities ? { capabilities } : { capabilities: {} }).run(request), ModelDriverError)
  }
  await assert.rejects(driver(event({ content: 'I have completed the task.' }, 'stop') + usage).run({ ...request, tools: [] }), ModelDriverError)
})

it('does not convert an oversized companion or cancellation into a tool result', async () => {
  await assert.rejects(driver(event({ content: 'X'.repeat(256_001), tool_calls: [call] }, 'tool_calls') + usage).run(request), ModelDriverError)
  const stop = new AbortController()
  const model = new OpenAIChatDriver('cancel-native-companion', { ...options, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(event({ content: 'I will read.' }))) },
    pull(controller) { stop.abort(new Error('synthetic cancellation')); controller.enqueue(new TextEncoder().encode(event({ tool_calls: [call] }, 'tool_calls') + usage)); controller.close() },
  })) })
  await assert.rejects(model.run({ ...request, signal: stop.signal }), /synthetic cancellation|timed out|disconnected/)
})

it('only projects the fixed non-public classification, never companion content or a supplied arbitrary label', () => {
  assert.deepEqual(publicModelDiagnostics({ publicText: 'unpublished_tool_companion', raw: 'PRIVATE_SENTINEL' }), { publicText: 'unpublished_tool_companion' })
  assert.deepEqual(publicModelDiagnostics({ publicText: 'PRIVATE_SENTINEL' }), {})
})

it('classifies an unframed final answer as a public protocol failure so correction restores the purpose contract', async () => {
  for (const content of ['The answer is 42.', 'null', 'true', 'false']) {
    await assert.rejects(driver(event({ content }, 'stop') + usage).run(request), error => {
      assert.ok(error instanceof ModelDriverError)
      assert.equal(error.diagnostics.protocolCode, 'public_text_invalid')
      const correction = modelProtocolCorrection(error.diagnostics, 'disabled', 'purpose-json-v2')
      assert.equal(correction.category, 'response_protocol')
      assert.match(correction.content, /purpose-json-v2/)
      assert.deepEqual(error.diagnostics.usage, { available: true, inputTokens: 17, outputTokens: 9 })
      return true
    })
  }
})
