// Synthetic regression only: no network, database, credentials or application data.
// Run with node --expose-gc after building. Exercise the actual SQL deadline wrapper.
// Expire every timer and advance GC/finalization turns before measuring retained heap.
import assert from 'node:assert/strict'
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises'
import { deadlinePool } from '../dist/src/control-plane/deadline-pool.js'
if (!global.gc) throw new Error('run with --expose-gc')
const root = new AbortController()
const raw = { async query() { return { rows: [], rowCount: 0 } }, release() {} }
const pool = deadlinePool({ ...raw, async connect() { return raw } }, root.signal, 5)
async function batch(count) {
  for (let i = 0; i < count; i++) {
    await pool.query('SELECT 1')
    if (i % 100 === 0) await immediate()
  }
  await delay(40)
  for (let i = 0; i < 4; i++) { global.gc(); await immediate() }
  return process.memoryUsage().heapUsed
}
const baseline = await batch(10_000)
const samples = []
for (let i = 0; i < 4; i++) samples.push(await batch(20_000))
const growth = samples.at(-1) - baseline
console.log(JSON.stringify({ node: process.version, operations: 90_000, baseline, samples, growth, limit: 4 * 1024 * 1024 }))
assert.ok(growth < 4 * 1024 * 1024, 'completed SQL deadlines retain memory on their long-lived parent signal')
root.abort()
