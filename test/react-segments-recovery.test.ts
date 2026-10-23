import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createHash } from 'node:crypto'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS } from '../src/index.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import type { RunEvent, WorkItem } from '../src/protocol/types.js'
import { nullLogger } from '../src/logging.js'
import { assemblePublicTextSources, snapshotPublicTextSources } from '../src/protocol/answer-segments.js'

// Written from docs/react-segments-recovery-failures.md before the owning
// implementation was frozen. No provider, production database or private data.
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
async function fixture() {
  const db = new PGlite(), directory = await mkdtemp(join(tmpdir(), 'react-segment-recovery-'))
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  let tail = Promise.resolve(), allow = true, failStep = false
  const acquire = async () => { let release!: () => void; const prior = tail; tail = new Promise<void>(resolve => { release = resolve }); await prior; return release }
  const query: SqlPool['query'] = async (sql, params) => {
    if (failStep && sql.includes('INSERT INTO lingxios.agent_steps')) throw new Error('synthetic sealed step persistence failure')
    const result = await db.query<Record<string, unknown>>(sql, params)
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
  }
  const pool: SqlPool = {
    async query(sql, params) { const release = await acquire(); try { return await query(sql, params) } finally { release() } },
    async connect() { return { query, release: await acquire() } },
  }
  const apps: Awaited<ReturnType<typeof createLingxiOS>>[] = []
  const open = async () => {
    const app = await createLingxiOS({ database: pool, homesRoot: directory, logger: nullLogger,
      realtime: { allowPublicText: () => allow } })
    apps.push(app); return app
  }
  const app = await open(), host = app.connectWorker({ workerId: 'react-recovery', workKinds: ['turn'] })
  const identity = { runId: 'react-run', tenantId: 'tenant', principalId: 'human', agentId: 'agent', sessionId: 'room' }
  await app.enqueue({ id: identity.runId, ...identity, text: 'Synthetic task.', mode: 'chat', codeExecution: 'disabled' })
  const work = (await host.claimWork())!
  const events = (partId: string, text: string, start: number, version = 1, fence = 1): RunEvent[] => {
    const data = { version: 3, purpose: 'answer', requestVersion: version, fence, attemptId: `call-${partId}`,
      messageId: `answer:${work.id}:v${version}`, segmentId: partId, partId, partIndex: 1, operation: 'append', supersedes: [] }
    return [
      { runId: work.id, seq: start, kind: 'public.text.operation', stage: 'started', visibility: 'user', data },
      { runId: work.id, seq: start + 1, kind: 'public.text.delta', stage: 'delta', visibility: 'user', data: { ...data, chunkIndex: 0, text } },
      { runId: work.id, seq: start + 2, kind: 'public.text.ended', stage: 'completed', visibility: 'user', data: { ...data, chunkCount: 1, reason: 'tool' } },
      { runId: work.id, seq: start + 3, kind: 'public.text.sealed', stage: 'completed', visibility: 'user', data: { ...data, chunkCount: 1, bodyHash: hash(text) } },
    ]
  }
  const emit = async (items: RunEvent[], lease: WorkItem = work, connection = host) => { for (const event of items) await connection.emitEvent(lease, event) }
  const sealedRows = () => pool.query("SELECT * FROM lingxios.agent_steps WHERE work_id=$1 AND kind='runtime.answer_segment' ORDER BY step_seq", [work.id])
  return { app, host, work, identity, pool, open, events, emit, sealedRows,
    setAllowed(value: boolean) { allow = value }, setFailStep(value: boolean) { failStep = value },
    async close() { for (const app of apps) await app.stop(); await db.close(); await rm(directory, { recursive: true, force: true }) },
  }
}

it('a durable seal and recovery record commit together, with identical ACK replay and fresh authorization', async () => {
  const f = await fixture()
  try {
    const events = f.events('segment-a', 'Useful A.', 1), seal = events[3]!
    await f.emit(events.slice(0, 3))
    await assert.rejects(f.host.emitEvent(f.work, { ...seal, data: { ...seal.data, bodyHash: hash('forged') } }), /seal|match/u)
    await assert.rejects(f.host.emitEvent(f.work, { ...seal, data: { ...seal.data, chunkCount: 2 } }), /seal|complete/u)
    f.setAllowed(false)
    await assert.rejects(f.host.emitEvent(f.work, seal), /authorized/u)
    assert.equal((await f.sealedRows()).rows.length, 0)
    f.setAllowed(true); f.setFailStep(true)
    await assert.rejects(f.host.emitEvent(f.work, seal), /synthetic/u)
    assert.equal((await f.app.readEvents(f.identity)).events.length, 3, 'failure after event insert rolls the event back too')
    assert.equal((await f.sealedRows()).rows.length, 0)
    f.setFailStep(false)
    await f.host.emitEvent(f.work, seal)
    await f.host.emitEvent(f.work, seal)
    assert.equal((await f.sealedRows()).rows.length, 1)
    assert.equal((await f.app.readEvents(f.identity)).events.length, 4)
    const context = await f.host.loadContext(f.work)
    const records = (context.executionSteps ?? []).filter(step => step.kind === 'runtime.answer_segment')
    assert.equal(records.length, 1)
    assert.equal(JSON.parse(records[0]!.output!).text, 'Useful A.')
    await assert.rejects(f.host.saveStep(f.work, { id: 'forged-seal', requestVersion: 1, kind: 'runtime.answer_segment',
      input: { ...seal.data, sealedSeq: seal.seq }, output: JSON.stringify({ text: 'forged' }), artifacts: [] }), /reserved/u)
    await assert.rejects(f.host.emitEvent(f.work, { ...seal, data: { ...seal.data, bodyHash: hash('changed ACK') } }), /conflicting/u)
  } finally { await f.close() }
})

it('a fresh fence recovers only durable sealed revisions across event pages and rejects old-fence new writes', async () => {
  const f = await fixture()
  try {
    for (let i = 0; i < 27; i++) await f.emit(f.events(`part-${i}`, `Useful ${i}.`, i * 4 + 1))
    await f.emit(f.events('unsealed', 'Incomplete draft.', 109).slice(0, 2))
    // Expire only this synthetic test lease; production leases are never edited.
    await f.pool.query("UPDATE lingxios.agent_work_items SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [f.work.id])
    await f.pool.query("UPDATE lingxios.agent_os_session_leases SET expires_at=NOW()-INTERVAL '1 second' WHERE work_id=$1", [f.work.id])
    const replacement = f.app.connectWorker({ workerId: 'react-replacement', workKinds: ['turn'] }), next = (await replacement.claimWork())!
    assert.equal(next.fence, 2)
    await assert.rejects(f.host.emitEvent(f.work, f.events('stale', 'Forbidden new write.', 111)[0]!), /lease/u)
    const recovered = await replacement.loadContext(next)
    const sealed = (recovered.executionSteps ?? []).filter(step => step.kind === 'runtime.answer_segment')
    assert.equal(sealed.length, 27)
    assert.equal(sealed.some(step => step.input['partId'] === 'unsealed'), false)
    assert.equal(sealed.every(step => step.input['fence'] === 1), true, 'legitimate old-fence seals retain provenance')
    const reader = await f.open(), seen: RunEvent[] = []
    let cursor = 0, pages = 0
    while (true) {
      const page = await reader.readEvents(f.identity, cursor)
      pages++; assert.ok(page.events.length <= 100); seen.push(...page.events)
      if (page.events.length < 100) break
      assert.ok(page.nextSeq > cursor); cursor = page.nextSeq
    }
    assert.equal(pages, 2)
    assert.equal(seen.filter(event => event.kind === 'public.text.sealed').length, 27)
    assert.equal(new Set(seen.map(event => event.seq)).size, seen.length)
    assert.equal((await reader.readEvents({ ...f.identity, principalId: 'unrelated' })).events.length, 0)
    await f.emit(f.events('new-fence', 'Current authorized continuation.', 100001, 1, 2), next, replacement)
    assert.equal((await f.sealedRows()).rows.length, 28)
  } finally { await f.close() }
})

for (const completedEvents of [0, 1, 2, 3]) it(`cancellation before publication boundary ${completedEvents} cannot seal or append`, async () => {
  const f = await fixture()
  try {
    const events = f.events('cancelled', 'Already observed prefix.', 1)
    await f.emit(events.slice(0, completedEvents))
    await f.app.cancel(f.identity)
    for (const event of events.slice(completedEvents)) await assert.rejects(f.host.emitEvent(f.work, event), /current|cancel|lease/u)
    assert.equal((await f.app.readEvents(f.identity)).events.length, completedEvents)
    assert.equal((await f.sealedRows()).rows.length, 0)
    assert.equal((await f.app.readRunState(f.identity))?.message, null)
  } finally { await f.close() }
})

it('source ranges preserve exact concatenation, outer trim and UTF-16 identity, rejecting structural tampering', () => {
  const raw = [' \n', '😀Gather', '\n\nCheck', '\t']
  const segments = raw.map((text, i) => ({ segmentId: `slot-${i}`, partId: `revision-${i}`, text, bodyHash: hash(text) }))
  const assembled = assemblePublicTextSources('answer:run:v1', segments, hash(raw.join('').trim()))
  assert.equal(assembled.body, '😀Gather\n\nCheck')
  assert.deepEqual(assembled.sources.segments.map(source => [source.start, source.end]), [[0, 0], [0, 8], [8, 15], [15, 15]])
  assert.deepEqual(assembled.sources.segments.map(source => source.partId), segments.map(segment => segment.partId))
  assert.deepEqual(assembled.sources.segments.map(source => source.bodyHash), raw.map(hash))
  assert.equal(assembled.sources.segments.map(source => assembled.body.slice(source.start, source.end)).join(''), assembled.body)
  const invalid = [
    { ...assembled.sources, segments: [...assembled.sources.segments].reverse() },
    { ...assembled.sources, segments: assembled.sources.segments.map((source, i) => i === 2 ? { ...source, start: 9 } : source) },
    { ...assembled.sources, segments: assembled.sources.segments.map((source, i) => i === 2 ? { ...source, start: 7 } : source) },
    { ...assembled.sources, segments: assembled.sources.segments.map((source, i) => i === 1 ? { ...source, end: 7.5 } : source) },
    { ...assembled.sources, segments: assembled.sources.segments.map((source, i) => i === 2 ? { ...source, partId: 'revision-1' } : source) },
    { ...assembled.sources, segments: assembled.sources.segments.map((source, i) => i === 2 ? { ...source, segmentId: 'slot-1' } : source) },
    { ...assembled.sources, segments: [] },
  ]
  for (const value of invalid) assert.throws(() => snapshotPublicTextSources(value, assembled.body.length))
  assert.throws(() => snapshotPublicTextSources(assembled.sources, assembled.body.length + 1))
})
