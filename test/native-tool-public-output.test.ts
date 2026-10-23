import assert from 'node:assert/strict'
import { it } from 'node:test'
import { NativeToolPublicOutput, wrapNativeToolSchema } from '../src/model/native-tool-public-output.js'
import { compileToolSchemas, validateToolBatch } from '../src/runtime/tool-batch.js'
import type { ToolDefinition } from '../src/tools/catalog.js'

const operation = { kind: 'append', supersedes: [] }
const publicWire = (answer: string) => JSON.stringify({ operation, commentary: '', answer, outcome: null })
const envelope = (answer: string | null, args = '{ "key" : "alpha" }') =>
  `{"public_output":${answer === null ? 'null' : publicWire(answer)},"arguments":${args}}`

it('streams declared answer before its string closes and before business args arrive', () => {
  const parser = new NativeToolPublicOutput()
  const prefix = '{"public_output":{"operation":{"kind":"append","supersedes":[]},"commentary":"","answer":"Known '
  const parts = [...prefix].flatMap(character => parser.push(character))
  assert.equal(parts.map(part => part.text).join(''), 'Known ')
  assert.deepEqual(parser.operation, operation)
  assert.throws(() => parser.finish())
})

it('preserves raw argument bytes and Unicode through every UTF-16 split', () => {
  // JSON.stringify makes the embedded quotes valid; spacing is deliberately noncanonical.
  const rawArgs = '{ "key" : ' + JSON.stringify('😀 and "public_output"') + ' }'
  const text = 'Known 😀 漢字\n escaped "value". '
  const wire = envelope(text, rawArgs)
  const parser = new NativeToolPublicOutput()
  const parts = wire.split('').flatMap(character => parser.push(character))
  const result = parser.finish()
  assert.equal(parts.map(part => part.text).join(''), text)
  assert.equal(result.arguments, rawArgs)
  assert.equal(result.text, text)
})

it('allows explicitly null public output without inventing an operation', () => {
  const parser = new NativeToolPublicOutput()
  assert.deepEqual(parser.push(envelope(null)), [])
  assert.deepEqual(parser.finish(), { arguments: '{ "key" : "alpha" }', text: '' })
})

for (const [name, wire] of Object.entries({
  duplicate: '{"public_output":null,"public_output":null,"arguments":{}}',
  extra: '{"public_output":null,"arguments":{},"extra":0}',
  truncated: envelope('Known text').slice(0, -2),
  trailing: envelope(null) + '{}',
  array: '{"public_output":null,"arguments":[]}',
  terminal: envelope('Known').replace('"outcome":null', '"outcome":{"status":"satisfied","gaps":[]}'),
  nullAnswer: envelope('Known').replace('"answer":"Known"', '"answer":null'),
  isolatedLowSurrogate: envelope(null).replace('alpha', '\udc00'),
  isolatedHighSurrogate: envelope(null).replace('alpha', '\ud800x'),
})) it(`rejects ${name} envelope`, () => {
  assert.throws(() => { const parser = new NativeToolPublicOutput(); parser.push(wire); parser.finish() })
})

it('accepts arguments before public output without pretending the answer arrived early', () => {
  const parser = new NativeToolPublicOutput()
  assert.deepEqual(parser.push('{"arguments":{ "key" : "alpha" },'), [])
  const parts = parser.push('"public_output":' + publicWire('Later known answer.') + '}')
  assert.equal(parts.map(part => part.text).join(''), 'Later known answer.')
  assert.equal(parser.finish().arguments, '{ "key" : "alpha" }')
})

for (const dialect of ['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2020-12/schema']) {
  for (const id of [undefined, '', '#', 'https://fixture.invalid/tool', 'relative-tool']) {
    it(`preserves root references for ${dialect} and id ${id}`, () => {
      const schema = { $schema: dialect, ...(id === undefined ? {} : { $id: id }), type: 'object',
        $defs: { key: { type: 'string', minLength: 2 } }, properties: { key: { $ref: '#/$defs/key' } },
        required: ['key'], additionalProperties: false }
      const before = JSON.stringify(schema)
      const tool: ToolDefinition = { name: 'fixture', action: 'fixture', effect: 'read', approval: false,
        description: 'Fixture', parameters: wrapNativeToolSchema(schema) }
      const original: ToolDefinition = { ...tool, parameters: schema as ToolDefinition['parameters'] }
      validateToolBatch([{ type: 'function_call', callId: 'original', name: tool.name, arguments: '{"key":"ok"}' }], [original], 'disabled', false)
      assert.throws(() => validateToolBatch([{ type: 'function_call', callId: 'original', name: tool.name, arguments: '{"key":2}' }], [original], 'disabled', false))
      compileToolSchemas([tool])
      const call = (key: unknown) => [{ type: 'function_call' as const, callId: 'id', name: 'fixture',
        arguments: JSON.stringify({ public_output: null, arguments: { key } }) }]
      validateToolBatch(call('ok'), [tool], 'disabled', false)
      assert.throws(() => validateToolBatch(call(2), [tool], 'disabled', false))
      assert.equal(JSON.stringify(schema), before)
    })
  }
}

for (const id of ['#root', 'tool#root', './dir/tool#root', 'https://fixture.invalid/tool#root']) {
  it(`preserves draft7 root fragment ${id}, local definitions and recursive anchor`, () => {
    const schema = { $schema: 'http://json-schema.org/draft-07/schema#', $id: id, type: 'object',
      $defs: { key: { type: 'string' } }, properties: { key: { $ref: '#/$defs/key' },
        child: { $ref: id.startsWith('#') || id.startsWith('./') ? '#' : '#root' } }, required: ['key'], additionalProperties: false }
    const tool: ToolDefinition = { name: 'fragment', action: 'fragment', effect: 'read', approval: false,
      description: 'Fixture', parameters: wrapNativeToolSchema(schema) }
    const original: ToolDefinition = { ...tool, parameters: schema as ToolDefinition['parameters'] }
    validateToolBatch([{ type: 'function_call', callId: 'original', name: tool.name, arguments: '{"key":"ok","child":{"key":"ok"}}' }], [original], 'disabled', false)
    assert.throws(() => validateToolBatch([{ type: 'function_call', callId: 'original', name: tool.name, arguments: '{"key":"ok","child":{"key":2}}' }], [original], 'disabled', false))
    compileToolSchemas([tool])
    const call = (key: unknown) => [{ type: 'function_call' as const, callId: 'id', name: 'fragment', arguments: JSON.stringify({ public_output: null, arguments: { key: 'ok', child: { key } } }) }]
    validateToolBatch(call('ok'), [tool], 'disabled', false)
    assert.throws(() => validateToolBatch(call(2), [tool], 'disabled', false))
  })
}

it('preserves relative child resources against a normalized relative business document', () => {
  const schema = { $id: './dir/tool', type: 'object',
    $defs: { child: { $id: 'child', type: 'string', minLength: 2 } },
    properties: { key: { $ref: 'child' } }, required: ['key'], additionalProperties: false }
  const base: ToolDefinition = { name: 'relative', action: 'relative', effect: 'read', approval: false,
    description: 'Fixture', parameters: schema as ToolDefinition['parameters'] }
  for (const wrapped of [false, true]) {
    const tool = { ...base, parameters: wrapped ? wrapNativeToolSchema(schema) : base.parameters }
    const call = (key: unknown) => [{ type: 'function_call' as const, callId: 'id', name: tool.name,
      arguments: JSON.stringify(wrapped ? { public_output: null, arguments: { key } } : { key }) }]
    validateToolBatch(call('ok'), [tool], 'disabled', false)
    assert.throws(() => validateToolBatch(call(2), [tool], 'disabled', false))
  }
})

it('alternating fresh wrapper compilation retains separate business resource schemas', () => {
  for (let index = 0; index < 6; index++) {
    const type = index % 2 ? 'string' : 'integer'
    const tool: ToolDefinition = { name: 'alternating', action: 'alternating', effect: 'read', approval: false, description: 'Fixture',
      parameters: wrapNativeToolSchema({ type: 'object', $defs: { value: { type } }, properties: { key: { $ref: '#/$defs/value' } }, required: ['key'], additionalProperties: false }) }
    const call = (key: unknown) => [{ type: 'function_call' as const, callId: 'id', name: tool.name, arguments: JSON.stringify({ public_output: null, arguments: { key } }) }]
    validateToolBatch(call(index % 2 ? 'ok' : 2), [tool], 'disabled', false)
    assert.throws(() => validateToolBatch(call(index % 2 ? 2 : 'wrong'), [tool], 'disabled', false))
  }
})

it('recompiling an embedded id cannot borrow a previous wrapper resource definition', () => {
  for (const type of ['string', 'integer', 'string']) {
    const tool: ToolDefinition = { name: 'rebound', action: 'rebound', effect: 'read', approval: false, description: 'Fixture',
      parameters: wrapNativeToolSchema({ $id: 'https://fixture.invalid/rebound', type: 'object',
        $defs: { value: { type } }, properties: { key: { $ref: '#/$defs/value' } }, required: ['key'], additionalProperties: false }) }
    const call = (key: unknown) => [{ type: 'function_call' as const, callId: 'id', name: tool.name, arguments: JSON.stringify({ public_output: null, arguments: { key } }) }]
    validateToolBatch(call(type === 'string' ? 'ok' : 2), [tool], 'disabled', false)
    assert.throws(() => validateToolBatch(call(type === 'string' ? 2 : 'wrong'), [tool], 'disabled', false))
  }
})

it('a previous catalog cannot supply an otherwise unresolved external reference', () => {
  const tool: ToolDefinition = { name: 'isolated', action: 'isolated', effect: 'read', approval: false, description: 'Fixture',
    parameters: wrapNativeToolSchema({ $id: 'https://fixture.invalid/catalog-only', type: 'object',
      $defs: { value: { type: 'string' } }, properties: {}, additionalProperties: false }) }
  compileToolSchemas([tool])
  const unbound: ToolDefinition = { ...tool, parameters: { type: 'object', properties: { key: { $ref: 'https://fixture.invalid/catalog-only#/$defs/value' } }, additionalProperties: false } }
  assert.throws(() => compileToolSchemas([unbound]), /resolve reference/)
})
