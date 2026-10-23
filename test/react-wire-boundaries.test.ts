/**
 * #366 failure model (written before this independent fixture suite):
 * - A valid partial answer and native tools must survive the same provider turn.
 * - Operation identity must precede every public delta; cancellation there emits none.
 * - JSON+tools incompatibility must not promote untyped prose/reasoning into answer.
 * - A malformed/duplicate/unknown tool, terminal outcome with tools, missing finish,
 *   duplicate finish, finish/tool mismatch or post-finish text cannot finalize.
 * - Null final answers need prior server-owned sources; partial remains partial.
 * - Framing limits must measure framing, not reject a valid large body in one chunk.
 * - Failure diagnostics retain observed usage but exclude provider content.
 * These are synthetic wire responses only, with no provider or recovery/database I/O.
 */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { ModelDriverError } from '../src/errors.js'
import { OpenAIChatDriver } from '../src/model/openai.js'
import type { ModelTurnRequest } from '../src/model/driver.js'
import type { ToolDefinition } from '../src/tools/catalog.js'

const lookup: ToolDefinition = {
  name: 'lookup_fixture', action: 'lookup_fixture', effect: 'read', approval: false,
  description: 'Read a synthetic fixture.',
  parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
}
const operation = { kind: 'append', supersedes: [] }
const satisfied = { status: 'satisfied', gaps: [] }
const wire = (answer: string | null, outcome: unknown = satisfied) => JSON.stringify({ operation, commentary: '', answer, outcome })
const call = (id = 'call-fixture', index = 0, args = '{"key":"alpha"}', name = lookup.name) =>
  ({ index, id, type: 'function', function: { name, arguments: args } })
const frame = (delta: unknown, finish: string | null = null, usage?: unknown) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
let sequence = 0
function fixture(stream: string, jsonObjectWithTools = false, parallelTools = false) {
  const bodies: Record<string, unknown>[] = []
  const model = new OpenAIChatDriver(`react-wire-fixture-${++sequence}`, {
    apiKey: 'synthetic-only', maxAttempts: 1, publicTextProtocol: 'purpose-json-v3',
    capabilities: { jsonObjectWithTools, parallelTools },
    fetchImpl: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(stream) },
  })
  const run = (request: Partial<ModelTurnRequest> = {}) => model.run({
    instructions: 'Synthetic protocol boundary fixture.', items: [], codeExecution: 'disabled', tools: [lookup], ...request,
  })
  return { run, bodies }
}

for (const jsonObjectWithTools of [false, true]) it(`v3 preserves same-turn answer and fragmented tools (combined mode ${jsonObjectWithTools})`, async () => {
  const events: Array<{ kind: string; value: unknown }> = []
  const text = 'Known value 😀. '
  const payload = wire(text, null)
  const stream = [...payload].map(character => frame({ content: character, reasoning_content: 'PRIVATE_REASONING_SENTINEL' })).join('')
    + frame({ tool_calls: [call('call-fixture', 0, '{"key":')] })
    + frame({ tool_calls: [{ index: 0, function: { arguments: '"alpha"}' } }] }, 'tool_calls') + 'data: [DONE]\n\n'
  const { run, bodies } = fixture(stream, jsonObjectWithTools)
  const result = await run({ onTextOperation: value => { events.push({ kind: 'operation', value }) },
    onTextDelta: (value, meta) => { events.push({ kind: meta?.purpose ?? 'unknown', value }) } })
  assert.deepEqual(events[0], { kind: 'operation', value: operation })
  assert.equal(events.filter(event => event.kind === 'answer').map(event => event.value).join(''), text)
  assert.equal(result.text, text)
  assert.deepEqual(result.answerOperation, operation)
  assert.equal(result.outcomeDeclaration, undefined)
  assert.deepEqual(result.output, [{ role: 'assistant', content: text },
    { type: 'function_call', callId: 'call-fixture', name: lookup.name, arguments: '{"key":"alpha"}' }])
  assert.equal(bodies.length, 1)
  assert.equal(Object.hasOwn(bodies[0]!, 'response_format'), jsonObjectWithTools)
  assert.doesNotMatch(JSON.stringify({ result, events }), /PRIVATE_REASONING_SENTINEL/)
})

it('v3 cancels at operation validation before any public text or tool return', async () => {
  const stop = new AbortController(), seen: string[] = []
  const { run } = fixture(frame({ content: wire('MUST_NOT_PUBLISH', null), tool_calls: [call()] }, 'tool_calls'))
  await assert.rejects(run({ signal: stop.signal,
    onTextOperation: () => { stop.abort(new Error('synthetic operation cancellation')) },
    onTextDelta: text => { seen.push(text) },
  }), /synthetic operation cancellation/)
  assert.deepEqual(seen, [])
})

it('v3 keeps an untyped native companion unpublished and does not invent an operation', async () => {
  const seen: unknown[] = []
  const { run } = fixture(frame({ content: 'Untyped provider progress.', reasoning_content: 'PRIVATE_REASONING_SENTINEL', tool_calls: [call()] }, 'tool_calls'))
  const result = await run({ onTextOperation: value => { seen.push(value) }, onTextDelta: value => { seen.push(value) } })
  assert.equal(result.text, '')
  assert.equal(result.answerOperation, undefined)
  assert.deepEqual(seen, [])
  assert.deepEqual(result.output, [{ type: 'function_call', callId: 'call-fixture', name: lookup.name, arguments: '{"key":"alpha"}' }])
  assert.doesNotMatch(JSON.stringify(result), /Untyped provider progress|PRIVATE_REASONING_SENTINEL/)
})

for (const [name, stream] of Object.entries({
  'untyped terminal prose': frame({ content: 'Unknown provider prose PRIVATE_TEXT_SENTINEL.' }, 'stop'),
  'terminal outcome with tools': frame({ content: wire('Provisional answer'), tool_calls: [call()] }, 'tool_calls'),
  'unknown native tool': frame({ content: wire('Provisional answer', null), tool_calls: [call('call-fixture', 0, '{}', 'unexposed')] }, 'tool_calls'),
  'duplicate native call identity': frame({ content: wire('Provisional answer', null), tool_calls: [call(), call('call-fixture', 1)] }, 'tool_calls'),
  'invalid native argument JSON': frame({ content: wire('Provisional answer', null), tool_calls: [call('call-fixture', 0, '{')] }, 'tool_calls'),
  'array native argument': frame({ content: wire('Provisional answer', null), tool_calls: [call('call-fixture', 0, '[]')] }, 'tool_calls'),
  'tool turn stop mismatch': frame({ content: wire('Provisional answer', null), tool_calls: [call()] }, 'stop'),
  'missing finish': frame({ content: wire('Provisional answer') }),
  'terminal tool_calls without tools': frame({ content: wire('Provisional answer') }, 'tool_calls'),
  'duplicate terminal finish': frame({ content: wire('Provisional answer') }, 'stop') + frame({}, 'stop'),
  'post-finish continuation': frame({ content: wire('Provisional answer') }, 'stop') + frame({ content: ' ' }),
  'output length exhaustion': frame({ content: wire('Provisional answer') }, 'length'),
  'incomplete outcome': frame({ content: wire('Provisional answer').slice(0, -2) }, 'stop'),
})) it(`v3 rejects ${name}`, async () => {
  const { run, bodies } = fixture(stream)
  await assert.rejects(run(), error => error instanceof ModelDriverError)
  assert.equal(bodies.length, 1, 'wire failures do not cause an unmetered provider retry')
})

it('v3 null terminal answer requires prior source identity and preserves partial declaration', async () => {
  for (const answerContext of [undefined, { messageId: 'message-fixture', segmentIds: [] }]) {
    await assert.rejects(fixture(frame({ content: wire(null) }, 'stop')).run({ answerContext }),
      error => error instanceof ModelDriverError && error.diagnostics.protocolCode === 'public_text_answer_required')
  }
  const partial = { status: 'partial', gaps: ['The remaining resource was not delivered.'] }
  const result = await fixture(frame({ content: wire(null, partial) }, 'stop')).run({
    answerContext: { messageId: 'message-fixture', segmentIds: ['active-part-fixture'] },
  })
  assert.equal(result.answerIsNull, true)
  assert.equal(result.text, '')
  assert.deepEqual(result.output, [])
  assert.deepEqual(result.outcomeDeclaration, partial)
})

it('v3 frames a large valid one-chunk answer without applying metadata limits to body size', async () => {
  const answer = 'Useful answer. '.repeat(1500)
  const result = await fixture(frame({ content: wire(answer) }, 'stop')).run({ tools: [] })
  assert.equal(result.text, answer)
})

it('v3 retains total body and metadata limits after allowing a large valid body chunk', async () => {
  for (const content of [wire('A'.repeat(256_001)), ' '.repeat(8193) + wire('Small answer')]) {
    await assert.rejects(fixture(frame({ content }, 'stop')).run({ tools: [] }),
      error => error instanceof ModelDriverError && error.diagnostics.kind === 'protocol')
  }
})

it('v3 rejects malformed declared JSON with measured usage and safe diagnostics', async () => {
  const stream = frame({ content: wire('PRIVATE_TEXT_SENTINEL').slice(0, -2) }, 'stop', { prompt_tokens: 17, completion_tokens: 9 })
  await assert.rejects(fixture(stream).run(), error => {
    assert.ok(error instanceof ModelDriverError)
    assert.equal(error.diagnostics.kind, 'protocol')
    assert.deepEqual(error.diagnostics.usage, { available: true, inputTokens: 17, outputTokens: 9 })
    assert.doesNotMatch(JSON.stringify(error.diagnostics) + error.message, /PRIVATE_TEXT_SENTINEL/)
    return true
  })
})
