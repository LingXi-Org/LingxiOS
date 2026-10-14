import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { boundedDirectToolOutput, boundedToolOutput, parseIPythonArguments } from '../src/runtime/tool.js'
import { observationRef } from '../src/context/observations.js'
import { parseTaskArgs } from '../src/tools/catalog.js'
import type { HostActionResult } from '../src/protocol/types.js'

it('requires exactly one complete receipt expectation or canonical SHA-256', () => {
  const identity = { idempotencyKey: '["run","cell",0]', action: 'documents.create' }
  for (const expectation of [{ expected: null }, { expected: { id: 'document' } }, { expectedSha256: 'a'.repeat(64) }]) {
    assert.doesNotThrow(() => parseTaskArgs('task.check_receipt', { ...identity, ...expectation }))
  }
  for (const expectation of [{}, { expected: {}, expectedSha256: 'a'.repeat(64) },
    ...[null, 123, '', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'A'.repeat(64)].map(expectedSha256 => ({ expectedSha256 }))]) {
    assert.throws(() => parseTaskArgs('task.check_receipt', { ...identity, ...expectation }))
  }
})

describe('parseIPythonArguments', () => {
  it('accepts a strict single-code object', () => {
    assert.deepEqual(parseIPythonArguments('{"code":"print(1)"}'), { code: 'print(1)' })
  })

  it('rejects non-JSON', () => {
    assert.throws(() => parseIPythonArguments('print(1)'), /strict JSON/)
  })

  it('rejects extra properties', () => {
    assert.throws(() => parseIPythonArguments('{"code":"x","lang":"py"}'), /exactly one property/)
  })

  it('rejects missing, empty, and non-string code', () => {
    assert.throws(() => parseIPythonArguments('{}'), /exactly one property/)
    assert.throws(() => parseIPythonArguments('{"code":"  "}'), /non-empty string/)
    assert.throws(() => parseIPythonArguments('{"code":42}'), /non-empty string/)
    assert.throws(() => parseIPythonArguments('["code"]'), /JSON object/)
  })
})

describe('boundedToolOutput', () => {
  it('keeps escaped previews and observation references within the same hard output bound', () => {
    const refs = Array.from({ length: 64 }, (_, index) => ({ actionKey: `key-${index}` + 'k'.repeat(100), sha256: 'a'.repeat(64), characters: 20_000 }))
    const output = boundedToolOutput({ blob: '\\"😀'.repeat(5000) }, 1000, refs)
    assert.ok(output.length <= 1000)
    const parsed = JSON.parse(output)
    assert.ok(parsed.omittedReferences > 0)
    assert.equal(parsed.observations[0].sha256, refs[0]!.sha256)
  })
  it('passes small payloads through verbatim', () => {
    assert.equal(boundedToolOutput({ a: 1 }), '{"a":1}')
  })

  it('truncates oversized payloads into valid JSON', () => {
    const output = boundedToolOutput({ blob: 'x'.repeat(20_000) }, 1_000)
    const parsed = JSON.parse(output) as { truncated: boolean; preview: string }
    assert.equal(parsed.truncated, true)
    assert.ok(output.length <= 1_000 + 40)
  })

  it('handles undefined without corrupting JSON', () => {
    assert.equal(boundedToolOutput(undefined), 'null')
  })
})

describe('boundedDirectToolOutput', () => {
  for (const limit of [512, 8000]) it(`reserves complete receipt identity within ${limit} characters`, () => {
    const receipt = { action: 'documents.read', idempotencyKey: JSON.stringify(['run', 'cell-\\"😀', 0]) }
    const result = { ok: true, value: { text: '\\"😀'.repeat(5000) },
      evidence: [{ sourceId: 'private', sourceVersion: '1', chunkId: 'chunk', title: 'Private', excerpt: 'private-evidence' }] }
    const output = boundedDirectToolOutput({ ...receipt, result }, limit)
    const parsed = JSON.parse(output)
    assert.deepEqual(parsed.receipt, { ...receipt, sha256: observationRef(receipt.idempotencyKey, result.value).sha256 })
    assert.equal(parsed.truncated, true)
    assert.ok(output.length <= limit)
    assert.doesNotMatch(output, /private-evidence|"evidence"/)
  })

  it('preserves the whole result value without interpreting nested receipt-looking fields', () => {
    const receipt = { action: 'documents.create', idempotencyKey: '["run","canonical",0]' }
    const result = { ok: true, executionState: 'succeeded' as const,
      value: { result: { id: 'document' }, state: { revision: 1 }, receipt: { idempotencyKey: 'untrusted-content' } } }
    assert.deepEqual(JSON.parse(boundedDirectToolOutput({ ...receipt, result })), {
      ...result, receipt: { ...receipt, sha256: observationRef(receipt.idempotencyKey, result.value).sha256 },
    })
  })

  it('does not advertise a value digest for unsuccessful or unsettled receipts', () => {
    const receipt = { action: 'documents.create', idempotencyKey: '["run","unsettled",0]' }
    const results: HostActionResult[] = [
      { ok: false, value: { id: 'document' }, executionState: 'rejected' },
      { ok: true, value: { id: 'document' }, executionState: 'unknown' },
      { ok: true, value: { id: 'document' }, approval: { id: 'approval', status: 'PENDING' } },
      { ok: true, value: { id: 'document' }, directive: { type: 'defer', reason: 'user' } },
      { ok: true },
    ]
    for (const result of results) {
      assert.deepEqual(JSON.parse(boundedDirectToolOutput({ ...receipt, result })).receipt, receipt)
    }
  })

  it('matches the persisted JSON value before and after receipt recovery', () => {
    const receipt = { action: 'documents.create', idempotencyKey: '["run","json",0]' }
    const value = { date: new Date('2026-10-14T00:00:00Z'), nested: { omitted: undefined, nonfinite: NaN }, list: [undefined, Infinity] }
    const persisted = JSON.parse(JSON.stringify(value))
    const sha256 = observationRef(receipt.idempotencyKey, persisted).sha256
    assert.deepEqual(JSON.parse(boundedDirectToolOutput({ ...receipt, result: { ok: true, value } })), {
      ok: true, value: persisted, receipt: { ...receipt, sha256 },
    })
    assert.deepEqual(JSON.parse(boundedDirectToolOutput({ ...receipt, result: { ok: true, value: persisted } }, undefined, { recovered: true })), {
      ok: true, value: persisted, receipt: { ...receipt, sha256 }, recovered: true,
    })
  })
})
