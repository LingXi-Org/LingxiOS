import assert from 'node:assert/strict'
import { it } from 'node:test'
import { projectMemoryHistory, stripMemorySources, memoryDependencies, legacyMemoryEvidence } from '../src/memory/history.js'
import { fitMemorySnapshot, snapshotMemories, memorySnapshotBody } from '../src/memory/context.js'
import { summaryItem } from '../src/runtime/compaction.js'
import type { ModelItem } from '../src/protocol/types.js'
import { memoryFixture } from './memory-fixture.js'

const epoch = { tenantId: 'tenant', scopeType: 'user', scopeId: 'owner', epoch: 0, forgottenAt: null }
const proof = { version: 1 as const, sources: [epoch] }
const snapshot = (epochNumber = 0) => snapshotMemories({ status: 'available', sourceEpochs: [{ ...epoch, epoch: epochNumber }],
  core: [], directory: [], recalled: [], strategies: [], omitted: { core: 0, directory: 0, recalled: 0, strategies: 0 },
  budget: { ratio: .1, maxTokens: 1024 }, retrieval: [] })

it('retains authorized memory and ordinary items, but invalidates old tool pairs and their mixed summary', () => {
  const items: ModelItem[] = [
    { type: 'function_call', name: 'memory__read', callId: 'm', arguments: '{"id":"private"}' },
    { type: 'function_call_output', callId: 'm', output: 'MEMORY_ONLY', memorySources: proof },
    { ...summaryItem('mixed MEMORY_ONLY and ordinary context'), memorySources: proof },
    { role: 'user', content: 'Original user MEMORY_ONLY remains.' },
    { role: 'assistant', content: 'Public final MEMORY_ONLY remains.' },
    { type: 'function_call_output', callId: 'ordinary', output: 'ORDINARY_TOOL' },
  ]
  assert.deepEqual(projectMemoryHistory(items, snapshot()), items)
  const projected = projectMemoryHistory(items, snapshot(1))
  assert.ok(!JSON.stringify(projected.slice(0, 3)).includes('MEMORY_ONLY'))
  assert.deepEqual(projected.slice(3), items.slice(3))
  assert.ok(JSON.stringify(items).includes('mixed MEMORY_ONLY'), 'durable source is unchanged')
  assert.deepEqual(memoryDependencies(projected.slice(0, 3)).sources, [])
})

it('rejects revoked sources and unproven legacy summaries only with server contamination evidence', () => {
  const legacy = summaryItem('LEGACY_MEMORY')
  assert.deepEqual(projectMemoryHistory([legacy], snapshot()), [legacy])
  const denied = { ...snapshot(), sourceEpochs: [], legacyMemoryInvalidated: true }
  assert.ok(!JSON.stringify(projectMemoryHistory([legacy], denied)).includes('LEGACY_MEMORY'))
  const clean = { ...summaryItem('ORDINARY_SUMMARY'), memorySources: { version: 1 as const, sources: [] } }
  assert.deepEqual(projectMemoryHistory([clean], denied), [clean])
  assert.ok(!JSON.stringify(projectMemoryHistory([{ ...legacy, memorySources: proof }], denied)).includes('LEGACY_MEMORY'))
})

it('control proof neither enters provider input nor consumes memory body allocation', () => {
  const plain = snapshot()
  const controlled = { ...plain, admission: true as const, sourceEpochs: Array.from({ length: 12 }, (_, i) => ({
    ...epoch, scopeId: `private-${i}-${'x'.repeat(1000)}`,
  })), legacyMemoryInvalidated: true }
  assert.deepEqual(memorySnapshotBody(fitMemorySnapshot(controlled, 128000)), memorySnapshotBody(fitMemorySnapshot(plain, 128000)))
  assert.equal(fitMemorySnapshot(controlled, 128000).sourceEpochs?.length, 12)
  assert.equal(JSON.stringify(memorySnapshotBody(controlled)).includes('private-'), false)
  assert.deepEqual(stripMemorySources([{ role: 'user', content: 'safe', memorySources: proof }]), [{ role: 'user', content: 'safe' }])
})

it('uses canonical legacy cell evidence without hiding unrelated ordinary tool observations', () => {
  const items: ModelItem[] = [
    { type: 'function_call', name: 'ipython', callId: 'memory-cell', stepId: 'source-step', arguments: 'old private arguments' },
    { type: 'function_call_output', callId: 'memory-cell', output: 'PRIVATE_LEGACY_OBSERVATION' },
    { type: 'function_call', name: 'ipython', callId: 'ordinary', stepId: 'other-step', arguments: 'ordinary code' },
    { type: 'function_call_output', callId: 'ordinary', output: 'ORDINARY_RESULT' },
  ]
  const projected = projectMemoryHistory(items, { ...snapshot(), legacyMemoryInvalidated: true,
    legacyMemoryCells: ['source-step'], legacyMemoryCellsComplete: true })
  assert.equal(JSON.stringify(projected).includes('PRIVATE_LEGACY_OBSERVATION'), false)
  assert.deepEqual(projected.slice(2), items.slice(2))
})

it('cannot promote a mixed or replayed old epoch into a newer proof', () => {
  const old: ModelItem = { ...summaryItem('PRIVATE_OLD_SUMMARY'), memorySources: proof }
  const latest = { ...snapshot(2), sourceEpochs: [{ ...epoch, epoch: 2, forgottenAt: '2026-10-20T00:00:00.000Z' }] }
  for (let repeat = 0; repeat < 3; repeat++) {
    const projected = projectMemoryHistory([old], latest)
    assert.equal(JSON.stringify(projected).includes('PRIVATE_OLD_SUMMARY'), false)
    assert.equal(old.memorySources?.sources[0]?.epoch, 0)
  }
  const mixed = memoryDependencies([old, { role: 'user', content: 'new', memorySources: {
    version: 1, sources: latest.sourceEpochs,
  } }])
  assert.equal(mixed.unknown, true)
  assert.ok(!JSON.stringify(projectMemoryHistory([{ ...old, memorySources: mixed }], latest)).includes('PRIVATE_OLD_SUMMARY'))
})

it('finds legacy implicit memory exposure from server event counts without reading any body', async () => {
  const fixture = await memoryFixture()
  try {
    const { work } = await fixture.source({ capture: false })
    assert.equal((await legacyMemoryEvidence(fixture.pool, work)).legacyMemoryInvalidated, false)
    await fixture.db.query(`INSERT INTO lingxios.agent_run_events(run_id,seq,tenant_id,agent_id,kind,stage,visibility,data)
      VALUES($1,1,'t','a','model.started','started','internal',$2::jsonb)`,
    [work.id, JSON.stringify({ memorySnapshot: { counts: { core: 1, directory: 0, recalled: 0, strategies: 0 } } })])
    const evidence = await legacyMemoryEvidence(fixture.pool, work)
    assert.equal(evidence.legacyMemoryInvalidated, true)
    assert.deepEqual(evidence.legacyMemoryCells, [])
    assert.equal((await legacyMemoryEvidence(fixture.pool, { ...work, principalId: 'other' })).legacyMemoryInvalidated, false)
  } finally { await fixture.close() }
})
