import assert from 'node:assert/strict'
import { it } from 'node:test'
import { evidenceItems, readEvidence, snapshotEvidence } from '../src/context/evidence.js'
import { boundedDirectToolOutput } from '../src/runtime/tool.js'
import { observationRef } from '../src/context/observations.js'

// A source excerpt can be incomplete while paging of that exact excerpt is complete.
it('provides an explicit end of excerpt without erasing source incompleteness', () => {
  const snapshot = snapshotEvidence('pages', [{ marker: 'S1', sourceId: 'source', sourceVersion: 'v1',
    chunkId: 'excerpt', title: 'Recorded excerpt', excerpt: 'first second', truncated: true }])
  const first = readEvidence(snapshot, { index: 0, offset: 0, limit: 6 })
  assert.equal(Reflect.get(first, 'hasMore'), true)
  assert.equal(first.nextOffset, 6)
  const last = readEvidence(snapshot, { index: 0, offset: 6, limit: 6 })
  assert.equal(Reflect.get(last, 'hasMore'), false)
  assert.equal(last.nextOffset, null)
  assert.equal(last.truncated, true, 'the stored excerpt still does not cover the full source')
  assert.equal(Reflect.get(last, 'sourceTruncated'), true)
  assert.equal(first.text + last.text, snapshot.items[0]!.excerpt)
  assert.equal(snapshot.items[0]!.truncated, true)
})

it('reports an empty EOF read as exhausted without fabricating additional evidence', () => {
  const snapshot = snapshotEvidence('pages', [{ marker: 'S1', sourceId: 'source', sourceVersion: 'v1',
    chunkId: 'whole', title: 'Recorded text', excerpt: 'complete' }])
  const eof = readEvidence(snapshot, { index: 0, offset: 8, limit: 8 })
  assert.equal(eof.text, '')
  assert.equal(Reflect.get(eof, 'hasMore'), false)
  assert.equal(eof.nextOffset, null)
  assert.equal(Reflect.get(eof, 'sourceTruncated'), false)
  assert.equal(snapshot.items.length, 1)
})

it('keeps complete short excerpts in a bounded large catalogue without rereading each one', () => {
  const items = Array.from({ length: 5 }, (_, index) => ({ marker: `S${index + 1}`, sourceId: `source-${index}`,
    sourceVersion: 'v1', chunkId: 'small', title: `Recorded source ${index}`,
    excerpt: `Unique observed claim ${index}. ` + '短原文'.repeat(300), truncated: true }))
  items.splice(1, 0, { marker: 'S6', sourceId: 'large', sourceVersion: 'v1', chunkId: 'large', title: 'Large source',
    excerpt: '长篇原文'.repeat(6000), truncated: true })
  const snapshot = snapshotEvidence('mixed', items), before = structuredClone(snapshot)
  const prompt = JSON.stringify(evidenceItems(snapshot, true))
  assert.ok(Buffer.byteLength(prompt) < 40_000)
  for (let index = 0; index < 5; index++) assert.ok(prompt.includes(`Unique observed claim ${index}.`))
  assert.ok(!prompt.includes(items[1]!.excerpt), 'the large excerpt remains explicitly on demand')
  assert.match(prompt, /task.read_evidence/)
  assert.deepEqual(snapshot, before)
})

it('preserves paged read structure and the original receipt when a model-visible range is bounded', () => {
  const value = { sourceId: 'source', sourceVersion: 'v1', status: 'ready', text: '\\"😀'.repeat(4000),
    offset: 700, nextOffset: 16700, textLength: 20000, truncated: true }
  const receipt = { action: 'documents.read', idempotencyKey: '["run","read",0]', result: { ok: true, value } }
  const before = structuredClone(receipt)
  const output = boundedDirectToolOutput(receipt)
  const rendered = JSON.parse(output)
  assert.ok(output.length <= 8000)
  assert.equal(rendered.ok, true)
  assert.equal(rendered.value.sourceId, 'source')
  assert.equal(rendered.value.sourceVersion, 'v1')
  assert.equal(rendered.value.offset, value.offset)
  assert.equal(rendered.value.textLength, value.textLength)
  assert.ok(rendered.value.text.length > 0 && rendered.value.text.length < value.text.length)
  assert.equal(rendered.value.text, value.text.slice(0, rendered.value.text.length))
  assert.equal(rendered.value.nextOffset, value.offset + rendered.value.text.length)
  assert.equal(rendered.value.hasMore, true)
  assert.equal(rendered.modelView.partial, true)
  assert.equal(rendered.receipt.sha256, observationRef(receipt.idempotencyKey, value).sha256)
  assert.deepEqual(receipt, before)
  const resumed = JSON.parse(boundedDirectToolOutput(receipt, undefined, { recovered: true }))
  assert.equal(resumed.value.text, value.text.slice(0, resumed.value.text.length))
  assert.equal(resumed.value.nextOffset, value.offset + resumed.value.text.length)
  assert.equal(resumed.receipt.sha256, rendered.receipt.sha256)
})

it('does not reinterpret malformed or unsettled ranges as a successful partial read', () => {
  const value = { sourceId: 'source', sourceVersion: 'v1', text: 'x'.repeat(20_000), offset: 0,
    nextOffset: 20_000, textLength: 30_000, truncated: true }
  for (const result of [{ ok: true, value: { ...value, nextOffset: 19_999 } },
    { ok: true, value: { ...value, offset: -1 } },
    { ok: false, value }, { ok: true, value, executionState: 'unknown' as const },
    { ok: true, value, approval: { id: 'pending', status: 'PENDING' as const } }]) {
    const rendered = JSON.parse(boundedDirectToolOutput({ action: 'documents.read', idempotencyKey: 'read', result }))
    assert.equal(rendered.modelView, undefined)
    assert.equal(rendered.truncated, true)
  }
  const receipt = { action: 'documents.read', idempotencyKey: 'read', result: { ok: true, value } }
  assert.throws(() => boundedDirectToolOutput(receipt, 8000.5), /tool output budget/)
})
