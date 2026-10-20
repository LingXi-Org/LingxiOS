import assert from 'node:assert/strict'
import { it } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const fixture = fileURLToPath(new URL('../../test/fixtures/forget-session-probe.mjs', import.meta.url))
type Call = { run: string; purpose: string; markerCount: number; receiptCount: number; summaryCount: number; dynamicMemoryCount: number }
type Receipt = { processId: number; calls: Call[]; memoryRows: number; userRequestMarkerCount: number; finalAnswerMarkerCount: number }

it('excludes forgotten memory-only receipts from later turns, compaction and a process restart', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lingxios-forget-session-test-'))
  try {
    for (const phase of ['seed', 'restart']) await execute(process.execPath, [fixture, phase, directory], { timeout: 15_000 })
    const seed = JSON.parse(await readFile(join(directory, 'seed-counts.json'), 'utf8')) as Receipt
    const restart = JSON.parse(await readFile(join(directory, 'restart-counts.json'), 'utf8')) as Receipt
    assert.notEqual(seed.processId, restart.processId)
    for (const receipt of [seed, restart]) {
      assert.equal(receipt.memoryRows, 0)
      assert.equal(receipt.userRequestMarkerCount, 0)
      assert.equal(receipt.finalAnswerMarkerCount, 0)
    }
    assert.equal(seed.calls[0]!.markerCount, 0, 'only the native memory read introduced this content')
    assert.ok(seed.calls.some(call => call.run === 'seed' && call.receiptCount > 0), 'authorized memory remains available')
    const later = [...seed.calls.filter(call => call.run !== 'seed'), ...restart.calls]
    assert.ok(later.some(call => call.purpose === 'compaction'), 'actual runtime compaction must execute')
    assert.ok(later.some(call => call.run === 'process-restart-after-forget'))
    assert.deepEqual(later.map(call => ({ run: call.run, purpose: call.purpose, count: call.markerCount })),
      later.map(call => ({ run: call.run, purpose: call.purpose, count: 0 })),
      'forgotten private tool observations must not return through history or derived summaries')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

for (const scenario of ['summary', 'legacy']) it(`invalidates ${scenario} derived before forget across restart while retaining current authorized messages`, { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lingxios-forget-summary-test-'))
  try {
    for (const phase of ['seed', 'restart']) await execute(process.execPath, [fixture, phase, directory, scenario], { timeout: 15_000 })
    const seed = JSON.parse(await readFile(join(directory, 'seed-counts.json'), 'utf8'))
    const restart = JSON.parse(await readFile(join(directory, 'restart-counts.json'), 'utf8'))
    assert.ok(seed.summaryBeforeForgetCount > 0)
    assert.equal(seed.durablePreserved, true)
    assert.ok(seed.persistedSummaryMarkerCount > 0, 'projection must not erase the original summary')
    for (const call of [...seed.calls.filter((call: Call) => call.run === 'warm-after-forget'), ...restart.calls]) {
      assert.equal(call.markerCount, 0)
      assert.equal(call.publicUserCount, 1)
      assert.equal(call.publicFinalCount, 1)
      assert.equal(call.controlFieldCount, 0)
    }
    assert.notEqual(seed.processId, restart.processId)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
