import assert from 'node:assert/strict'
import { it } from 'node:test'
import { OpenAIChatDriver } from '../src/model/openai.js'
import type { ModelTurnRequest } from '../src/model/driver.js'
import type { ToolDefinition } from '../src/tools/catalog.js'

const business: ToolDefinition = { name: 'record__read', action: 'record.read', effect: 'read', approval: false,
  description: 'Read a synthetic record.', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } }
const operation = { kind: 'append', supersedes: [] }
const terminal = { status: 'satisfied', gaps: [] }
const publicArgs = (answer: string | null, outcome: unknown = null) => JSON.stringify({ operation, answer, outcome })
const frame = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\n`
const call = (args: string, name = 'public_answer', id = 'public-id', index = 0) => ({ index, id, type: 'function', function: { name, arguments: args } })
const done = 'data: [DONE]\n\n'
const options = { apiKey: 'synthetic', publicTextProtocol: 'purpose-json-v3' as const, publicTextContinuation: 'typed-message-v1' as const,
  publicAnswerTool: 'native-v1' as const, capabilities: { jsonObjectWithTools: false, parallelTools: false }, maxAttempts: 1 }
const request: ModelTurnRequest = { instructions: 'Use only supplied synthetic facts.', items: [], tools: [business], codeExecution: 'disabled' }
function fixture(wire: string) {
  const requests: Array<Record<string, unknown>> = []
  const model = new OpenAIChatDriver('public-answer-fixture', { ...options, fetchImpl: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(wire)
  } })
  return { model, requests }
}

it('public-answer terminal uses one generation, one output binding and byte-identical business schema', async () => {
  const args = publicArgs('43', terminal), f = fixture(frame({ tool_calls: [call(args)] }, 'tool_calls') + done)
  const result = await f.model.run(request)
  assert.equal(result.text, '43'); assert.deepEqual(result.outcomeDeclaration, terminal)
  assert.deepEqual(result.publicAnswerCall, { type: 'function_call', callId: 'public-id', name: 'public_answer', arguments: args })
  assert.deepEqual(result.output, [], 'the output binding is not a dispatchable business tool')
  assert.equal(result.publicTextPhase, undefined); assert.equal(f.requests.length, 1)
  const payload = f.requests[0]!, tools = payload['tools'] as Array<{ type: string; function: { name: string; parameters: Record<string, unknown> } }>
  assert.equal(payload['stream'], true); assert.equal(payload['tool_choice'], 'auto'); assert.equal(payload['parallel_tool_calls'], false)
  assert.equal(tools.length, 2)
  assert.deepEqual(tools.find(t => t.function.name === business.name)?.function.parameters, business.parameters)
  const output = tools.find(t => t.function.name === 'public_answer')!
  assert.deepEqual(output.function.parameters['required'], ['operation', 'answer', 'outcome'])
  assert.ok((output.function.parameters['properties'] as Record<string, unknown>)['commentary'])
  assert.equal(tools.filter(t => t.function.name === 'public_answer').length, 1)
  const system = (payload['messages'] as Array<{ content: string }>)[0]!.content
  assert.equal(f.model.protocolTokens, f.model.countTokens(system.slice(request.instructions.length + 2)))
})

it('streams a Unicode answer before argument/string completion, only after late name and ID become complete', async () => {
  const answer = 'Known 😀 facts. 中文.', args = publicArgs(answer), prefix = args.slice(0, args.indexOf('Known') + 6)
  let identified = false, finished = false, seen = '', release!: () => void
  const observed = new Promise<void>(resolve => { release = resolve })
  const model = new OpenAIChatDriver('public-answer-fixture', { ...options, fetchImpl: async () => new Response(new ReadableStream({ async start(controller) {
    const send = (delta: unknown, finish: string | null = null) => controller.enqueue(new TextEncoder().encode(frame(delta, finish)))
    try {
      send({ tool_calls: [{ index: 0, function: { name: 'public_', arguments: prefix } }] })
      await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(seen, '')
      identified = true
      send({ tool_calls: [{ index: 0, id: 'public-id', type: 'function', function: { name: 'answer', arguments: '' } }] })
      await observed
      assert.equal(finished, false, 'partial answer must leave before the JSON string closes')
      for (const unit of args.slice(prefix.length).split('')) send({ tool_calls: [{ index: 0, function: { name: '', arguments: unit } }] })
      finished = true; send({}, 'tool_calls'); controller.enqueue(new TextEncoder().encode(done)); controller.close()
    } catch (error) { controller.error(error) }
  } })) })
  try {
    const result = await model.run({ ...request, signal: AbortSignal.timeout(1500), onTextDelta: (text, meta) => {
      assert.ok(identified); assert.equal(meta?.purpose, 'answer'); seen += text; release()
    } })
    assert.equal(seen, answer); assert.equal(result.text, answer); assert.equal(result.publicTextPhase, 'intermediate')
    assert.equal(result.publicAnswerCall?.arguments, args, 'preserve original native argument bytes for history')
    assert.doesNotMatch(seen, /\uFFFD/)
  } finally { release() }
})

it('never promotes ordinary companion or reasoning while accepting the explicit public binding', async () => {
  const f = fixture(frame({ content: 'Private ordinary prose.', reasoning_content: 'Private hidden reasoning.' })
    + frame({ tool_calls: [call(publicArgs('Known fact.', terminal))] }, 'tool_calls') + done)
  let seen = ''
  const result = await f.model.run({ ...request, onTextDelta: text => { seen += text } })
  assert.equal(seen, 'Known fact.'); assert.equal(result.text, 'Known fact.')
  assert.doesNotMatch(JSON.stringify(result), /Private ordinary|Private hidden/)
})

it('business native arguments remain unwrapped and ordinary companion stays private', async () => {
  const args = '{ "key" : "value" }', f = fixture(frame({ content: 'I will read it.' })
    + frame({ tool_calls: [call(args, business.name, 'business-id')] }, 'tool_calls') + done)
  let seen = ''
  const result = await f.model.run({ ...request, onTextDelta: text => { seen += text } })
  assert.equal(seen, ''); assert.equal(result.text, ''); assert.equal(result.publicAnswerCall, undefined)
  assert.deepEqual(result.output.filter(item => 'type' in item), [{ type: 'function_call', callId: 'business-id', name: business.name, arguments: args }])
})

const valid = publicArgs('Known fact.', terminal)
const invalidWires: Record<string, string> = {
  'public then business': frame({ tool_calls: [call(valid), call('{"key":"v"}', business.name, 'business', 1)] }, 'tool_calls'),
  'business then public': frame({ tool_calls: [call('{"key":"v"}', business.name), call(valid, 'public_answer', 'other', 1)] }, 'tool_calls'),
  'two public calls': frame({ tool_calls: [call(valid), call(valid, 'public_answer', 'other', 1)] }, 'tool_calls'),
  'duplicate public identity at another index': frame({ tool_calls: [call(valid), call(valid, 'public_answer', 'public-id', 1)] }, 'tool_calls'),
  'late changed identity': frame({ tool_calls: [call(valid)] }) + frame({ tool_calls: [{ index: 0, id: 'changed' }] }, 'tool_calls'),
  'late unknown field': frame({ tool_calls: [call(valid.slice(0, -1) + ',"secret":"no"}')] }, 'tool_calls'),
  'truncated object': frame({ tool_calls: [call(valid.slice(0, -1))] }, 'tool_calls'),
  'no finish': frame({ tool_calls: [call(valid)] }),
  'length finish': frame({ tool_calls: [call(valid)] }, 'length'),
  'empty intermediate': frame({ tool_calls: [call(publicArgs(''))] }, 'tool_calls'),
  'null intermediate': frame({ tool_calls: [call(publicArgs(null))] }, 'tool_calls'),
  'no native ID': frame({ tool_calls: [{ index: 0, function: { name: 'public_answer', arguments: valid } }] }, 'tool_calls'),
  'unresolved name prefix': frame({ tool_calls: [call(valid, 'public_')] }, 'tool_calls'),
  'typed second content channel': frame({ content: publicArgs('Conflicting content.', terminal) }) + frame({ tool_calls: [call(valid)] }, 'tool_calls'),
}
for (const [name, wire] of Object.entries(invalidWires)) it(`rejects the whole original turn for ${name}`, async () => {
  await assert.rejects(fixture(wire + done).model.run(request))
})

it('cancellation from the operation boundary releases no answer and no completed native result', async () => {
  const f = fixture(frame({ tool_calls: [call(valid)] }, 'tool_calls') + done), stop = new AbortController(), seen: string[] = []
  await assert.rejects(f.model.run({ ...request, signal: stop.signal, onTextOperation: () => { stop.abort() }, onTextDelta: text => { seen.push(text) } }))
  assert.deepEqual(seen, [])
})

it('output capability is fingerprinted, clone-safe and removed from private-v2 without changing its identity', () => {
  const f = fixture('').model
  const { publicAnswerTool: _cap, ...legacy } = options
  const old = new OpenAIChatDriver('public-answer-fixture', legacy)
  assert.notEqual(f.configurationFingerprint, old.configurationFingerprint)
  assert.equal(f.publicAnswerTool, 'native-v1'); assert.equal(f.singleAttempt().publicAnswerTool, 'native-v1')
  const privateModel = f.withPublicTextProtocol('purpose-json-v2')
  assert.equal(privateModel.publicAnswerTool, undefined)
  assert.equal(privateModel.configurationFingerprint, old.withPublicTextProtocol('purpose-json-v2').configurationFingerprint)
  for (const bad of [{ publicTextProtocol: 'purpose-json-v2' as const }, { publicTextContinuation: undefined },
    { capabilities: { jsonObjectWithTools: true, parallelTools: false } }, { capabilities: { jsonObjectWithTools: false, parallelTools: true } },
    { nativeToolPublicOutput: 'envelope-v1' as const }]) assert.throws(() => new OpenAIChatDriver('invalid', { ...options, ...bad }))
})

it('does not shadow an authorized business tool whose name collides with the reserved output name', async () => {
  await assert.rejects(fixture(frame({ tool_calls: [call(valid)] }, 'tool_calls') + done).model.run({ ...request, tools: [{ ...business, name: 'public_answer' }] }))
})

it('quota/execution wrappers preserve output capability and meter one native output exactly once', async () => {
  const { executionModel, DEFAULT_MODEL_BUDGET } = await import('../src/model/execution.js')
  const { limitModel } = await import('../src/model/quota.js')
  const { ResourceQuota } = await import('../src/resource-quota.js')
  let reservations = 0, settlements = 0
  const f = fixture(frame({ tool_calls: [call(valid)] }, 'tool_calls') + done)
  const wrapped = executionModel({ reserveModelCall: async () => { reservations++; return { allowed: true, deadlineAt: new Date(Date.now() + 5000).toISOString(), remainingCalls: 10, remainingTokens: 100000, remainingCostMicros: 1000000 } },
    recordModelUsage: async () => { settlements++ } }, limitModel(f.model, new ResourceQuota(1)),
    { id: 'work', fence: 1, tenantId: 'tenant', agentId: 'agent', sessionId: 'session' } as import('../src/protocol/types.js').WorkItem, DEFAULT_MODEL_BUDGET)
  assert.equal(wrapped.publicAnswerTool, 'native-v1')
  assert.equal((await wrapped.run(request)).text, 'Known fact.')
  assert.deepEqual({ reservations, settlements, fetches: f.requests.length }, { reservations: 1, settlements: 1, fetches: 1 })
})
