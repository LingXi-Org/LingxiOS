import assert from 'node:assert/strict'
import { it } from 'node:test'
import { OpenAIChatDriver } from '../src/model/openai.js'
import { inputTokens } from '../src/model/profile.js'
import type { ToolDefinition } from '../src/tools/catalog.js'

const tool: ToolDefinition = { name: 'fixture', action: 'fixture', effect: 'read', approval: false,
  description: 'Synthetic fixture.', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } }
const operation = { kind: 'append', supersedes: [] }
const publicWire = (answer: string, outcome: unknown = null) => JSON.stringify({ operation, commentary: '', answer, outcome })
const args = '{ "key" : "value" }'
const envelope = (answer: string | null) => '{"public_output":' + (answer === null ? 'null' : publicWire(answer)) + ',"arguments":' + args + '}'
const frame = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`
const call = (argumentsText: string, index = 0, name = 'fixture', id = 'call-id') => ({ index, id, type: 'function', function: { name, arguments: argumentsText } })
const request = { instructions: 'Synthetic public fixture', items: [], tools: [tool], codeExecution: 'disabled' as const }
const options = { apiKey: 'synthetic', publicTextProtocol: 'purpose-json-v3' as const, maxAttempts: 1,
  capabilities: { jsonObjectWithTools: false, parallelTools: false }, nativeToolPublicOutput: 'envelope-v1' as const }

it('publishes answer before string closure and unfinished native args without an extra generation', async () => {
  let requests = 0, release!: () => void
  const observed = new Promise<void>(resolve => { release = resolve })
  const prefix = '{"public_output":{"operation":{"kind":"append","supersedes":[]},"commentary":"","answer":"Known '
  const wire = envelope('Known 😀 content. ')
  const chunks: string[] = []
  const bodies: Record<string, unknown>[] = []
  const model = new OpenAIChatDriver('fixture', { ...options, fetchImpl: async (_url, init) => {
    requests++; bodies.push(JSON.parse(String(init?.body)))
    return new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(new TextEncoder().encode(frame({ tool_calls: [call(prefix)] })))
      await observed
      controller.enqueue(new TextEncoder().encode(frame({ tool_calls: [{ index: 0, function: { arguments: wire.slice(prefix.length) } }] }, 'tool_calls') + 'data: [DONE]\n\n'))
      controller.close()
    } }))
  } })
  const result = await model.run({ ...request, signal: AbortSignal.timeout(3000), onTextDelta: (text, meta) => {
    assert.equal(meta?.purpose, 'answer'); chunks.push(text); if (chunks.join('') === 'Known ') release()
  } })
  assert.equal(requests, 1)
  assert.equal(chunks.join(''), 'Known 😀 content. ')
  assert.equal(result.text, 'Known 😀 content. ')
  assert.deepEqual(result.answerOperation, operation)
  assert.deepEqual(result.output[1], { type: 'function_call', callId: 'call-id', name: 'fixture', arguments: args })
  assert.equal(Object.hasOwn(bodies[0]!, 'response_format'), false)
  assert.doesNotMatch(JSON.stringify(bodies[0]), /Tool-turn assistant content example|assistant content still uses the complete purpose-json-v3/)
})

for (const [name, wire] of Object.entries({
  conflict: frame({ content: publicWire('From content', { status: 'satisfied', gaps: [] }) }) + frame({ tool_calls: [call(envelope('From tool'))] }, 'tool_calls'),
  lateContent: frame({ tool_calls: [call(envelope('Known'))] }) + frame({ content: publicWire('late') }, 'tool_calls'),
  twoCalls: frame({ tool_calls: [call(envelope('Known')), call(envelope(null), 1, 'fixture', 'second')] }, 'tool_calls'),
  badSchema: frame({ tool_calls: [call(envelope('Known').replace('"value"', '3'))] }, 'tool_calls'),
  truncated: frame({ tool_calls: [call(envelope('Known').slice(0, -2))] }, 'tool_calls'),
  unknown: frame({ tool_calls: [call(envelope('Known'), 0, 'unknown')] }, 'tool_calls'),
  lateId: frame({ tool_calls: [call(envelope('Known'))] }) + frame({ tool_calls: [{ index: 0, id: 'changed' }] }, 'tool_calls'),
  badFinish: frame({ tool_calls: [call(envelope('Known'))] }, 'stop'),
})) it(`rejects ${name} without a successful driver result`, async () => {
  const model = new OpenAIChatDriver('fixture', { ...options, fetchImpl: async () => new Response(wire + 'data: [DONE]\n\n') })
  await assert.rejects(model.run(request))
})

for (const order of ['before', 'after'] as const) it(`keeps untyped companion ${order} the envelope unpublished`, async () => {
  const prose = frame({ content: '  ' }) + frame({ content: 'Work' }) + frame({ content: 'ing now.' })
  const native = frame({ tool_calls: [call(envelope('Known answer.'))] })
  const model = new OpenAIChatDriver('fixture', { ...options, fetchImpl: async () => new Response(
    (order === 'before' ? prose + native : native + prose) + frame({}, 'tool_calls') + 'data: [DONE]\n\n') })
  const seen: string[] = []
  const result = await model.run({ ...request, onTextDelta: text => { seen.push(text) } })
  assert.equal(seen.join(''), 'Known answer.')
  assert.equal(result.text, 'Known answer.')
  assert.doesNotMatch(JSON.stringify(result), /Working now/)
})

for (const value of ['null', 'true', 'false']) for (const order of ['before', 'after'] as const) {
  it(`rejects JSON primitive companion ${value} ${order} the envelope`, async () => {
    const content = frame({ content: value })
    const native = frame({ tool_calls: [call(envelope(null))] })
    const model = new OpenAIChatDriver('fixture', { ...options, fetchImpl: async () => new Response(
      (order === 'before' ? content + native : native + content) + frame({}, 'tool_calls') + 'data: [DONE]\n\n') })
    await assert.rejects(model.run(request))
  })
}

it('keeps terminal no-tool v3 in one call and auxiliary calls unwrapped', async () => {
  const bodies: Record<string, unknown>[] = []
  const model = new OpenAIChatDriver('fixture', { ...options, fetchImpl: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body)
    if (body.stream) return new Response(frame({ content: publicWire('5', { status: 'satisfied', gaps: [] }) }, 'stop') + 'data: [DONE]\n\n')
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"value":"ok"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
  } })
  assert.equal((await model.run({ ...request, tools: [] })).text, '5')
  assert.equal(bodies.length, 1)
  await model.structured({ instructions: 'Auxiliary', input: {} })
  assert.doesNotMatch(JSON.stringify(bodies[1]), /public_output|Native tool public output/)
  await model.compact({ instructions: 'Compact', items: [] })
  assert.doesNotMatch(JSON.stringify(bodies[2]), /public_output|native tool public output/)
})

it('internal v2 executes with its actual private protocol and no envelope wire', async () => {
  let requests = 0
  const model = new OpenAIChatDriver('fixture', { ...options, fetchImpl: async (_url, init) => {
    requests++; assert.doesNotMatch(String(init?.body), /public_output|native tool public output/)
    return new Response(frame({ content: JSON.stringify({ commentary: '', answer: 'Private result', outcome: { status: 'satisfied', gaps: [] } }) }, 'stop') + 'data: [DONE]\n\n')
  } }).withPublicTextProtocol('purpose-json-v2')
  assert.equal((await model.run(request)).text, 'Private result'); assert.equal(requests, 1)
})

it('answers simple arithmetic with tools exposed in one generation and zero tool calls', async () => {
  let requests = 0
  const model = new OpenAIChatDriver('fixture', { ...options, fetchImpl: async () => {
    requests++; return new Response(frame({ content: publicWire('5', { status: 'satisfied', gaps: [] }) }, 'stop') + 'data: [DONE]\n\n')
  } })
  const result = await model.run({ ...request, instructions: 'What is 2 + 3? Only the number.' })
  assert.equal(result.text, '5'); assert.equal(requests, 1)
  assert.equal(result.output.some(item => 'type' in item && item.type === 'function_call'), false)
})

it('rewraps only provider history without mutating canonical args or duplicating answer', async () => {
  let body: Record<string, unknown> = {}
  const model = new OpenAIChatDriver('fixture', { ...options, fetchImpl: async (_url, init) => {
    body = JSON.parse(String(init?.body)); return new Response(frame({ content: publicWire('Done', { status: 'satisfied', gaps: [] }) }, 'stop') + 'data: [DONE]\n\n')
  } })
  const items = [{ role: 'assistant' as const, content: 'Already published once' },
    { type: 'function_call' as const, callId: 'original-id', name: 'fixture', arguments: args },
    { type: 'function_call_output' as const, callId: 'original-id', output: 'ok' }]
  const before = JSON.stringify(items)
  await model.run({ ...request, items })
  assert.equal(JSON.stringify(items), before)
  const assistant = (body['messages'] as Array<Record<string, unknown>>)[1]!
  const calls = assistant['tool_calls'] as Array<{ id: string; function: { arguments: string } }>
  assert.equal(calls[0]!.id, 'original-id')
  assert.equal(calls[0]!.function.arguments, '{"public_output":null,"arguments":' + args + '}')
  assert.equal((JSON.stringify(body).match(/Already published once/g) ?? []).length, 1)
})

it('freezes policy identity, preserves singleAttempt, and removes it for internal v2', () => {
  const plain = new OpenAIChatDriver('fixture', { ...options, nativeToolPublicOutput: undefined })
  const enabled = new OpenAIChatDriver('fixture', options)
  assert.notEqual(enabled.configurationFingerprint, plain.configurationFingerprint)
  assert.equal(enabled.singleAttempt().configurationFingerprint, enabled.configurationFingerprint)
  const privateModel = enabled.withPublicTextProtocol('purpose-json-v2')
  const plainPrivate = plain.withPublicTextProtocol('purpose-json-v2')
  assert.equal(privateModel.configurationFingerprint, plainPrivate.configurationFingerprint)
  assert.throws(() => new OpenAIChatDriver('fixture', { ...options, capabilities: { jsonObjectWithTools: false, parallelTools: true } }))
})

it('counts actual wrapped tools, instructions and history for generation only', () => {
  const plain = new OpenAIChatDriver('fixture', { ...options, nativeToolPublicOutput: undefined })
  const model = new OpenAIChatDriver('fixture', options)
  const manyTools = { ...request, tools: [tool, ...Array.from({ length: 4 }, (_, index) => ({ ...tool, name: `fixture_${index}` }))] }
  assert.ok(inputTokens(model, manyTools, true) > inputTokens(plain, manyTools, true))
  assert.equal(inputTokens(model, { instructions: 'auxiliary', input: {} }), inputTokens(plain, { instructions: 'auxiliary', input: {} }))
})

it('actual wire estimate survives quota/execution wrappers and protects ledger admission', async () => {
  const { executionModel, DEFAULT_MODEL_BUDGET } = await import('../src/model/execution.js')
  const { limitModel } = await import('../src/model/quota.js')
  const { ResourceQuota } = await import('../src/resource-quota.js')
  const { ModelContextBudgetError } = await import('../src/errors.js')
  let fetches = 0
  const reserved: number[] = []
  const work = { id: 'envelope-budget', fence: 1, tenantId: 'tenant', agentId: 'agent', sessionId: 'room' } as import('../src/protocol/types.js').WorkItem
  const host: Pick<import('../src/host/port.js').HostPort, 'reserveModelCall' | 'recordModelUsage'> = {
    reserveModelCall: async (_work, _call, limits) => { reserved.push(limits.reservedInputTokens!); return { allowed: true,
      deadlineAt: new Date(Date.now() + 5000).toISOString(), remainingCalls: 10, remainingTokens: 100000, remainingCostMicros: 1000000 } },
    recordModelUsage: async () => {},
  }
  const fetchImpl: typeof fetch = async () => { fetches++; return new Response(frame({ tool_calls: [call(envelope(null))] }, 'tool_calls') + 'data: [DONE]\n\n') }
  const driver = new OpenAIChatDriver('fixture', { ...options, maxOutputTokens: 10, fetchImpl })
  const manyTools = { ...request, tools: [tool, ...Array.from({ length: 4 }, (_, index) => ({ ...tool, name: `fixture_${index}` }))] }
  const actualWire = driver.generationInputTokens(manyTools)!
  const plain = new OpenAIChatDriver('fixture', { ...options, maxOutputTokens: 10, nativeToolPublicOutput: undefined })
  const legacy = inputTokens(plain, manyTools, true)
  assert.ok(actualWire > legacy)
  const execution = executionModel(host, limitModel(driver, new ResourceQuota(1)), work, DEFAULT_MODEL_BUDGET)
  assert.equal(execution.generationInputTokens?.(manyTools), actualWire)
  await execution.run(manyTools)
  assert.ok(reserved[0]! >= actualWire)
  const nearContext = Math.ceil((legacy + 10 + 512 + (actualWire - legacy) / 2) / 0.9)
  const bounded = executionModel(host, limitModel(new OpenAIChatDriver('fixture', { ...options,
    maxOutputTokens: 10, contextWindowTokens: nearContext, fetchImpl }), new ResourceQuota(1)), work, DEFAULT_MODEL_BUDGET)
  await assert.rejects(async () => bounded.run(manyTools), ModelContextBudgetError)
  assert.equal(fetches, 1)
  assert.equal(reserved.length, 1, 'context rejection precedes even budget reservation')
})

it('cancels after public operation without publishing text or returning a call', async () => {
  const stop = new AbortController(), seen: string[] = []
  const model = new OpenAIChatDriver('fixture', { ...options, fetchImpl: async () => new Response(frame({ tool_calls: [call(envelope('Known'))] }, 'tool_calls')) })
  await assert.rejects(model.run({ ...request, signal: stop.signal,
    onTextOperation: () => { stop.abort(new Error('synthetic cancellation')) }, onTextDelta: text => { seen.push(text) } }))
  assert.deepEqual(seen, [])
})
