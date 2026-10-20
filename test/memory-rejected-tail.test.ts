import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { it } from 'node:test'
import { memoryFixture, content } from './memory-fixture.js'
import { withTransaction } from '../src/control-plane/pg-store.js'
import { executeMemorySynthesis, type MemoryBatch } from '../src/memory/synthesis.js'

it('continues unseen segments after rejected proposals and terminates without retrying rejected windows', async () => {
  const f = await memoryFixture()
  try {
    const tail = 'SYNTHETIC_UNSEEN_TAIL', source = await f.source({ text: '普通前段材料。'.repeat(2500) + tail })
    let job = (await f.reflection()).job, cursor = 0, pages = 0, sawTail = false, total = 0
    assert.ok(job)
    while (job) {
      assert.ok(++pages <= 10, 'rejected windows must not loop')
      const invoke = (method: string, args: Record<string, unknown>) => withTransaction(f.pool, db => executeMemorySynthesis(db, job!, method, args, f.options))
      const batch = await invoke('load', {}) as MemoryBatch
      const evidence = batch.evidence[0]!, segment = evidence.segment
      assert.equal(segment.start, cursor)
      assert.ok(segment.next > cursor, 'each new work must advance beyond rejected input')
      assert.ok(segment.next - segment.start <= 2)
      total = segment.total; cursor = segment.next
      sawTail ||= evidence.userText.includes(tail)
      const proposal = { changes: [{ sourceRunIds: [source.work.id], change: { action: 'create', content: content('Synthetic unverified proposal.') } }], conflicts: [], approved: false, confidence: 0.2 }
      await invoke('apply', proposal)
      await invoke('apply', proposal) // Replayed work may return no-op; it must not advance another page.
      assert.equal((await f.db.query<{ segment_cursor: number }>('SELECT segment_cursor FROM lingxios.agent_memory_evidence_scopes')).rows[0]!.segment_cursor, cursor)
      await f.store.complete(job.id, job.fence, createHash('sha256').update(job.leaseToken).digest('hex'), { status: 'completed' })
      job = (await f.reflection()).job
      if (cursor < total) assert.ok(job, 'rejection must not abandon unread tail')
    }
    assert.ok(pages > 1)
    assert.equal(cursor, total)
    assert.ok(sawTail)
    assert.equal((await f.db.query<{ n: number }>('SELECT count(*)::int AS n FROM lingxios.agent_memories')).rows[0]!.n, 0)
    assert.equal((await f.db.query<{ status: string }>('SELECT status FROM lingxios.agent_memory_evidence_scopes')).rows[0]!.status, 'rejected')
    assert.equal((await f.reflection()).job, null)
  } finally { await f.close() }
})
