import assert from 'node:assert/strict'
import { it } from 'node:test'
import { ModelDriverError } from '../src/errors.js'
import { OpenAIChatDriver } from '../src/model/openai.js'
import type { ToolDefinition } from '../src/tools/catalog.js'
import { PUBLIC_PURPOSE_INSTRUCTIONS } from '../src/model/public-purpose.js'

const lookup: ToolDefinition = {
  name: 'lookup_fixture', action: 'lookup_fixture', effect: 'read', approval: false,
  description: 'Read a synthetic fixture value.',
  parameters: { type: 'object', properties: { key: { type: 'string', enum: ['alpha'] } }, required: ['key'], additionalProperties: false },
}
const event = (delta: unknown, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`
const nativeCall = { index: 0, id: 'fixture-call', function: { name: lookup.name, arguments: '{"key":"alpha"}' } }

it('preserves the legacy default fingerprint while distinguishing the combined-tool opt-out', () => {
  // Existing replay identity must survive adding a capability whose default
  // preserves the old wire request. Keep the pre-capability snapshot fixed.
  const options = { apiKey: 'synthetic-only' }
  const defaultModel = new OpenAIChatDriver('fixture', options)
  const explicitDefault = new OpenAIChatDriver('fixture', { ...options, capabilities: { jsonObjectWithTools: true } })
  const optedOut = new OpenAIChatDriver('fixture', { ...options, capabilities: { jsonObjectWithTools: false } })
  assert.equal(defaultModel.configurationFingerprint, 'c69171f62097093e89728df6c837f1088c7c258ef3e1c60d0cfdd053461c24ea')
  assert.equal(explicitDefault.configurationFingerprint, defaultModel.configurationFingerprint)
  assert.notEqual(optedOut.configurationFingerprint, defaultModel.configurationFingerprint)
  assert.equal(optedOut.singleAttempt().configurationFingerprint, optedOut.configurationFingerprint)
})

it('opts out of combined JSON mode and native tools without dropping the public purpose contract', async () => {
  const bodies: Record<string, unknown>[] = []
  const capabilities = { parallelTools: false, jsonObjectWithTools: false }
  const model = new OpenAIChatDriver('combined-format-fixture', {
    apiKey: 'fixture', maxAttempts: 1, publicTextProtocol: 'purpose-json-v1', capabilities,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body)
      // A provider can support JSON mode and native tools independently while its
      // JSON decoder produces only content when both are requested together.
      return new Response(body.response_format
        ? event({ content: '{"commentary":"Checking","answer":"The lookup is still needed."}' }, 'stop')
        : event({ tool_calls: [nativeCall] }, 'tool_calls'))
    },
  })
  const result = await model.run({ instructions: 'Read the synthetic fixture.', items: [{ role: 'user', content: 'Look up alpha.' }],
    tools: [lookup], codeExecution: 'disabled' })
  assert.deepEqual(result.output, [{ type: 'function_call', callId: 'fixture-call', name: lookup.name, arguments: '{"key":"alpha"}' }])
  assert.equal(bodies.length, 1)
  assert.equal(Object.hasOwn(bodies[0]!, 'response_format'), false)
  assert.equal(bodies[0]!['tool_choice'], 'auto')
  assert.equal(bodies[0]!['parallel_tool_calls'], false)
  assert.deepEqual(bodies[0]!['tools'], [{ type: 'function', function: { name: lookup.name, description: lookup.description, parameters: lookup.parameters } }])
  assert.ok(JSON.stringify(bodies[0]!['messages']).includes(JSON.stringify(PUBLIC_PURPOSE_INSTRUCTIONS).slice(1, -1)))
})

it('keeps JSON mode for purpose requests with no exposed tools after opting out of the combination', async () => {
  const capabilities = { parallelTools: false, jsonObjectWithTools: false }
  for (const toolConfig of [{ codeExecution: 'disabled' as const }, { tools: [] }]) {
    const model = new OpenAIChatDriver('combined-format-no-tools-fixture', {
      apiKey: 'fixture', maxAttempts: 1, publicTextProtocol: 'purpose-json-v1', capabilities,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        assert.deepEqual(body.response_format, { type: 'json_object' })
        assert.equal(Object.hasOwn(body, 'tools'), false)
        return new Response(event({ content: '{"commentary":"","answer":"Answer."}' }, 'stop'))
      },
    })
    assert.equal((await model.run({ instructions: 'Answer.', items: [], ...toolConfig })).text, 'Answer.')
  }
})

it('applies the opt-out to the implicit Python tool and preserves it in single-attempt drivers', async () => {
  const capabilities = { parallelTools: false, jsonObjectWithTools: false }
  const model = new OpenAIChatDriver('combined-format-python-fixture', {
    apiKey: 'fixture', maxAttempts: 1, publicTextProtocol: 'purpose-json-v1', capabilities,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      assert.equal(Object.hasOwn(body, 'response_format'), false)
      assert.deepEqual(body.tools.map((tool: { function: { name: string } }) => tool.function.name), ['ipython'])
      return new Response(event({ content: '{"commentary":"","answer":"Answer."}' }, 'stop'))
    },
  })
  assert.equal((await model.singleAttempt().run({ instructions: 'Answer.', items: [] })).text, 'Answer.')
})

it('retains auxiliary JSON mode and independent configuration identity for combined-tool capability', async () => {
  const capabilities = { parallelTools: false, jsonObjectWithTools: false }
  for (const auxiliaryStreaming of [false, true]) {
    const model = new OpenAIChatDriver('combined-format-auxiliary-fixture', {
      apiKey: 'fixture', maxAttempts: 1, publicTextProtocol: 'purpose-json-v1', capabilities, auxiliaryStreaming,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        assert.deepEqual(body.response_format, { type: 'json_object' })
        assert.equal(Object.hasOwn(body, 'tools'), false)
        const content = '{"summary":"Fixture summary."}'
        return body.stream ? new Response(event({ content }, 'stop'))
          : Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] })
      },
    })
    await model.structured({ instructions: 'Fixture JSON.', input: {} })
    await model.compact({ instructions: 'Summarize.', items: [] })
  }
  const options = { apiKey: 'fixture', publicTextProtocol: 'purpose-json-v1' as const }
  const legacy = new OpenAIChatDriver('combined-format-identity-fixture', options)
  const supportedCapabilities = { ...capabilities, jsonObjectWithTools: true }
  const supported = new OpenAIChatDriver('combined-format-identity-fixture', { ...options, capabilities: supportedCapabilities })
  const unsupported = new OpenAIChatDriver('combined-format-identity-fixture', { ...options, capabilities })
  assert.notEqual(unsupported.configurationFingerprint, supported.configurationFingerprint)
  assert.equal(Reflect.get(legacy.profile, 'jsonObjectWithTools'), true)
  assert.equal(Reflect.get(unsupported.profile, 'jsonObjectWithTools'), false)
  assert.equal(unsupported.singleAttempt().configurationFingerprint, unsupported.configurationFingerprint)
  assert.equal(new OpenAIChatDriver('combined-format-identity-fixture', { ...options, capabilities: { jsonObjectWithTools: true } }).configurationFingerprint,
    legacy.configurationFingerprint)
  for (const value of [null, 'false', 0]) {
    assert.throws(() => new OpenAIChatDriver('invalid-combined-format-fixture', { apiKey: 'fixture', capabilities: JSON.parse(JSON.stringify({ jsonObjectWithTools: value })) }),
      /invalid model capability jsonObjectWithTools/)
  }
})

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

for (const jsonObjectWithTools of [true, false]) for (const content of [
  ...(jsonObjectWithTools ? ['Unframed public progress.'] : []),
  '{"commentary":"Checking","answer":""} trailing',
  '{"commentary":"Checking","answer":"',
]) it(`rejects malformed public content with a native call (combined JSON mode ${jsonObjectWithTools}): ${JSON.stringify(content)}`, async () => {
  const model = new OpenAIChatDriver('native-purpose-rejection-fixture', {
    apiKey: 'fixture', maxAttempts: 1, publicTextProtocol: 'purpose-json-v1',
    capabilities: { jsonObjectWithTools },
    fetchImpl: async () => new Response(event({ content, tool_calls: [nativeCall] }, 'tool_calls') + 'data: [DONE]\n\n'),
  })
  await assert.rejects(model.run({ instructions: 'Read the synthetic fixture.', items: [], tools: [lookup], codeExecution: 'disabled' }),
    error => error instanceof ModelDriverError && error.diagnostics.kind === 'protocol')
})

for (const jsonObjectWithTools of [true, false]) it(`does not turn tool-shaped answer text into a native call (combined JSON mode ${jsonObjectWithTools})`, async () => {
  const answer = JSON.stringify({ tool_calls: [nativeCall] })
  const model = new OpenAIChatDriver('embedded-native-purpose-fixture', {
    apiKey: 'fixture', maxAttempts: 1, publicTextProtocol: 'purpose-json-v1',
    capabilities: { jsonObjectWithTools },
    fetchImpl: async () => new Response(event({ content: JSON.stringify({ commentary: '', answer }) }, 'stop') + 'data: [DONE]\n\n'),
  })
  const result = await model.run({ instructions: 'Read the synthetic fixture.', items: [], tools: [lookup], codeExecution: 'disabled' })
  assert.deepEqual(result.output, [{ role: 'assistant', content: answer }])
})

it('keeps measured usage, tool identity validation, and cancellation when combined JSON mode is disabled', async () => {
  for (const invalidIdentity of [false, true]) {
    const model = new OpenAIChatDriver('combined-format-usage-fixture', {
      apiKey: 'fixture', maxAttempts: 1, publicTextProtocol: 'purpose-json-v1', capabilities: { jsonObjectWithTools: false },
      fetchImpl: async () => new Response('data: ' + JSON.stringify({
        choices: [{ delta: { tool_calls: [{ ...nativeCall, function: { ...nativeCall.function, name: invalidIdentity ? 'unexposed' : lookup.name } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 17, completion_tokens: 9 },
      }) + '\n\n'),
    })
    const result = model.run({ instructions: 'Fixture.', items: [], tools: [lookup], codeExecution: 'disabled' })
    if (invalidIdentity) await assert.rejects(result, error => {
      assert.ok(error instanceof ModelDriverError)
      assert.equal(error.diagnostics.protocolCode, 'tool_identity_invalid')
      assert.deepEqual(error.diagnostics.usage, { available: true, inputTokens: 17, outputTokens: 9 })
      return true
    })
    else assert.deepEqual((await result).usage, { available: true, inputTokens: 17, outputTokens: 9 })
  }
  const stop = new AbortController(), previews: string[] = []
  const model = new OpenAIChatDriver('combined-format-cancellation-fixture', {
    apiKey: 'fixture', maxAttempts: 1, publicTextProtocol: 'purpose-json-v1', capabilities: { jsonObjectWithTools: false },
    fetchImpl: async () => new Response(event({ content: '{"commentary":"Checking","answer":"MUST_NOT_PUBLISH"}', tool_calls: [nativeCall] }, 'tool_calls')),
  })
  await assert.rejects(model.run({ instructions: 'Fixture.', items: [], tools: [lookup], codeExecution: 'disabled', signal: stop.signal,
    onTextDelta: text => { previews.push(text); stop.abort(new Error('cancelled fixture')) } }), /cancelled fixture/)
  assert.deepEqual(previews, ['Checking'])
})
