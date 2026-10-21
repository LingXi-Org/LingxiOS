import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { it } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS } from '../src/app/index.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import { DEFAULT_MODEL_BUDGET, modelExecution } from '../src/model/execution.js'
import type { RunIdentity } from '../src/app/jobs.js'

// Failure model: docs/public-run-trace/contract.md, written before implementation.
async function fixture() {
  const db = new PGlite()
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  const pool: SqlPool = { query: async (sql, params) => {
    const result = await db.query<Record<string, unknown>>(sql, params)
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
  }, connect: async () => ({ query: pool.query, release() {} }) }
  const app = await createLingxiOS({ database: pool, background: { role: 'passive' }, performance: { notifications: false } })
  const host = app.connectWorker({ workerId: 'trace-worker', workKinds: ['turn'] })
  const identity = { runId: 'trace-run', tenantId: 'tenant', agentId: 'agent', sessionId: 'session', principalId: 'human' }
  await app.enqueue({ ...identity, id: identity.runId, text: 'Synthetic trace request' })
  return { db, pool, app, host, identity, close: async () => { await app.stop(); await db.close() } }
}
// A structural interface keeps the first test run at the missing public API,
// rather than passing due to an implementation-only helper.
type Snapshot = { origin: number|null; spans: Array<{ spanId: string; parentSpanId: string|null; kind: string; state: string; startedAt: number|null; completedAt: number|null; callId?: string; inputTokens?: number|null; outputTokens?: number|null; usageAvailable?: boolean; costMicros?: number|null; attemptId: string|null; requestVersion: number|null; fence: number|null }> }
const trace = (app: unknown, identity: RunIdentity): Promise<Snapshot|null> => (app as { readRunTrace(identity: RunIdentity): Promise<Snapshot|null> }).readRunTrace(identity)
it('persists actual model boundaries before execution, replaces replay stably and never exposes private payloads', async () => {
  const f = await fixture()
  try {
    const queued = (await trace(f.app, f.identity))!
    assert.equal(queued.origin, null)
    const work = (await f.host.claimWork())!
    let seq = 0
    await f.host.emitEvent(work, { runId: work.id, seq: ++seq, kind: 'run.started', stage: 'started', visibility: 'user', data: {} })
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { entered = resolve })
    const execution = modelExecution(f.host, { modelId: 'synthetic-model' }, work, DEFAULT_MODEL_BUDGET,
      event => f.host.emitEvent(work, { ...event, runId: work.id, seq: ++seq }))
    const result = execution.invoke('agent-turn', { instructions: 'PRIVATE-PROMPT', input: 'PRIVATE-INPUT' }, async () => {
      entered(); await gate
      return { model: 'synthetic-model', usage: { available: true, inputTokens: 11, outputTokens: 7 } }
    })
    await ready
    const running = (await trace(f.app, f.identity))!, model = running.spans.find(span => span.kind === 'llm')!
    assert.ok(model.startedAt); assert.equal(model.completedAt, null); assert.equal(model.state, 'running')
    assert.equal(model.requestVersion, 1); assert.equal(model.fence, work.fence); assert.equal(model.attemptId, model.callId)
    assert.equal(model.inputTokens, null)
    release(); await result
    const complete = (await trace(f.app, f.identity))!, settled = complete.spans.find(span => span.spanId === model.spanId)!
    assert.equal(settled.startedAt, model.startedAt); assert.ok(settled.completedAt! >= model.startedAt!)
    assert.equal(settled.usageAvailable, true); assert.equal(settled.inputTokens, 11); assert.equal(settled.outputTokens, 7)
    assert.equal(settled.costMicros, null, 'default zero pricing is not proof of a free call')
    assert.equal(settled.state, 'complete'); assert.equal(settled.parentSpanId, complete.spans.find(span => span.kind === 'agent')!.spanId)
    assert.equal(/PRIVATE-|instructions|prompt|leaseToken|reasoning|configurationFingerprint/.test(JSON.stringify(complete)), false)
    assert.deepEqual(await trace(f.app, f.identity), complete)
    for (const changed of [{ tenantId: 'other' }, { principalId: 'other' }, { sessionId: 'other' }, { threadId: 'other' }]) {
      assert.equal(await trace(f.app, { ...f.identity, ...changed }), null)
    }
    const response = await f.app.streamRun(f.identity, { signal: AbortSignal.timeout(3000), lastEventId: '99999', trace: true } as Parameters<typeof f.app.streamRun>[1])
    const reader = response.body!.getReader()
    try {
      for (;;) {
        const part = await reader.read(); assert.equal(part.done, false)
        const text = new TextDecoder().decode(part.value)
        if (text.includes('event: trace')) { assert.ok(text.includes(model.spanId)); assert.equal(text.includes('PRIVATE-'), false); break }
      }
    } finally { await reader.cancel() }
  } finally { await f.close() }
})
it('does not fabricate tool completion on cancellation, and rejects stale event overwrites', async () => {
  const f = await fixture()
  try {
    const work = (await f.host.claimWork())!
    const event = { runId: work.id, seq: 1, kind: 'tool.started', stage: 'started' as const, visibility: 'user' as const,
      data: { toolCallId: 'tool-1', name: 'documents.read', attemptId: 'explicit-model-attempt', requestVersion: 1 } }
    await f.host.emitEvent(work, event); await f.host.emitEvent(work, event)
    await f.host.completeWork(work, { status: 'cancelled' })
    const snapshot = (await trace(f.app, f.identity))!, tool = snapshot.spans.find(span => span.kind === 'tool')!
    assert.equal(snapshot.spans.filter(span => span.kind === 'tool').length, 1)
    assert.equal(tool.state, 'unknown'); assert.equal(tool.completedAt, null); assert.ok(tool.startedAt)
    assert.equal(tool.attemptId, 'explicit-model-attempt')
    await assert.rejects(f.host.emitEvent(work, { ...event, seq: 2, kind: 'tool.completed', stage: 'completed', data: { toolCallId: 'tool-1' } }), /lease/)
    assert.deepEqual(await trace(f.app, f.identity), snapshot)
  } finally { await f.close() }
})
it('discovers native graph children explicitly, enforces child scope and revokes live/replayed IM reads', async () => {
  const f = await fixture()
  try {
    await f.app.cancel(f.identity)
    const policy: import('../src/collaboration/types.js').ConversationPolicy = { tenantId: 'tenant', conversationId: 'room', version: 1, kind: 'group',
      owner: { kind: 'participant', id: 'human' }, defaultAgentId: 'agent', participants: [
        { id: 'human', kind: 'human', capabilities: ['read', 'execute'] },
        ...['agent', 'helper'].map(id => ({ id, kind: 'agent' as const, capabilities: ['read', 'execute', 'speak'] as Array<'read'|'execute'|'speak'> })),
      ] }
    await f.app.conversations.sync(policy)
    const root = (await f.app.conversations.ingest({ tenantId: 'tenant', conversationId: 'room', policyVersion: 1,
      messageId: 'synthetic-im', version: 1, author: { id: 'human', kind: 'human' }, text: 'Delegate a synthetic task' })).runs[0]!
    const work = (await f.host.claimWork())!
    const { sessionKeyOf } = await import('../src/protocol/types.js')
    const { snapshotRequest } = await import('../src/context/request.js')
    await f.host.saveSession(work, { key: sessionKeyOf(work), tenantId: work.tenantId, agentId: work.agentId, sessionId: work.sessionId,
      history: [], appliedWorkIds: [work.id], revision: 0, compactionEpoch: 0, request: snapshotRequest(await f.host.loadContext(work)) })
    await f.host.reserveModelCall(work, 'graph-admission', { maxModelCalls: 128, maxTokens: 1000000, maxCostMicros: 10000000,
      deadlineAt: new Date(Date.now()+1800000).toISOString(), reservedTokens: 120, reservedInputTokens: 100, reservedOutputTokens: 20,
      childAdmission: { inputTokens: 100, outputTokens: 20, executionMs: 1000 } })
    const graph = await f.app.graphs.enqueue(root, { id: 'synthetic-graph', nodes: [{ id: 'child', agentId: 'helper', text: 'Bounded child' }] })
    const childId = graph.nodes[0]!.workId
    const first = (await f.app.readRunTrace(root))!
    const child = first.spans.find(span => span.childRunId === childId)!
    assert.ok(child); assert.equal(child.parentSpanId, first.rootSpanId)
    assert.equal(child.startedAt, null); assert.equal(child.completedAt, null)
    assert.equal(JSON.stringify(first).includes('delegate-session:'), false)
    // Synthetic corruption probes: a parent link does not authorize another thread,
    // tenant/principal or frozen audience. Never infer access merely from the link.
    for (const column of ['tenant_id', 'principal_id', 'thread_id']) {
      const original = (await f.db.query<Record<string, unknown>>(`SELECT ${column} FROM lingxios.agent_work_items WHERE id=$1`, [childId])).rows[0]![column]
      await f.db.query(`UPDATE lingxios.agent_work_items SET ${column}='different-scope' WHERE id=$1`, [childId])
      assert.equal((await f.app.readRunTrace(root))!.spans.some(span => span.childRunId === childId), false)
      await f.db.query(`UPDATE lingxios.agent_work_items SET ${column}=$2 WHERE id=$1`, [childId, original])
    }
    await f.db.query(`UPDATE lingxios.agent_work_items SET conversation=jsonb_set(conversation,'{audience,participantIds}','["agent","helper"]') WHERE id=$1`, [childId])
    assert.equal((await f.app.readRunTrace(root))!.spans.some(span => span.childRunId === childId), false)
    const response = await f.app.streamRun(root, { trace: true, signal: AbortSignal.timeout(5000) })
    const reader = response.body!.getReader()
    for (;;) { const part = await reader.read(); if (new TextDecoder().decode(part.value).includes('event: trace')) break }
    await f.app.conversations.sync({ ...policy, version: 2, owner: { kind: 'organization', id: 'tenant' }, participants: policy.participants.filter(item => item.id !== 'human') })
    await assert.rejects(f.app.readRunTrace(root), /participant|forbidden|capability/)
    await assert.rejects(f.app.streamRun(root, { trace: true }), /participant|forbidden|capability/)
    await assert.rejects(async () => { for (;;) { const item = await reader.read(); if (item.done) assert.fail('revoked stream completed without denial') } }, /participant|forbidden|capability/)
  } finally { await f.close() }
})
it('preserves local model cancellation settlement and unknown usage after lease completion', async () => {
  const f = await fixture()
  try {
    const work = (await f.host.claimWork())!, abort = new AbortController()
    let seq = 0, entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const execution = modelExecution(f.host, { modelId: 'synthetic-model' }, work, DEFAULT_MODEL_BUDGET,
      event => f.host.emitEvent(work, { ...event, runId: work.id, seq: ++seq }))
    const result = execution.invoke('agent-turn', { signal: abort.signal }, async () => { entered(); return new Promise<never>(() => {}) })
    const rejected = assert.rejects(result)
    await ready
    await f.host.completeWork(work, { status: 'cancelled' })
    abort.abort(new Error('Synthetic cancellation'))
    await rejected
    const model = (await f.app.readRunTrace(f.identity))!.spans.find(span => span.kind === 'llm')!
    assert.equal(model.state, 'cancelled'); assert.ok(model.startedAt); assert.ok(model.completedAt! >= model.startedAt!)
    assert.equal(model.usageAvailable, false); assert.equal(model.inputTokens, null); assert.equal(model.outputTokens, null)
    const before = await f.app.readRunTrace(f.identity)
    await assert.rejects(f.host.recordModelUsage(work, model.callId!, { inputTokens: 999, outputTokens: 999, costMicros: 0 }), /rewritten/)
    assert.deepEqual(await f.app.readRunTrace(f.identity), before)
  } finally { await f.close() }
})
it('bounds graph discovery and keeps legacy/waiting timing and unconfirmed totals unknown', async () => {
  const f = await fixture()
  try {
    const work = (await f.host.claimWork())!
    const { sessionKeyOf } = await import('../src/protocol/types.js')
    const { snapshotRequest } = await import('../src/context/request.js')
    await f.host.saveSession(work, { key: sessionKeyOf(work), tenantId: work.tenantId, agentId: work.agentId, sessionId: work.sessionId,
      history: [], appliedWorkIds: [work.id], revision: 0, compactionEpoch: 0, request: snapshotRequest(await f.host.loadContext(work)) })
    await f.host.reserveModelCall(work, 'graph-admission', { maxModelCalls: 128, maxTokens: 1000000, maxCostMicros: 10000000,
      deadlineAt: new Date(Date.now()+1800000).toISOString(), reservedTokens: 120, reservedInputTokens: 100, reservedOutputTokens: 20,
      childAdmission: { inputTokens: 100, outputTokens: 20, executionMs: 1000 } })
    // Native admission allows eight active descendants. Build bounded historical
    // batches, settling synthetic fixture rows between batches rather than weakening it.
    for (let batch = 0; batch < 5; batch++) {
      const graph = await f.app.graphs.enqueue(f.identity, { id: `bounded-graph-${batch}`, nodes: Array.from({ length: 8 }, (_, index) => ({ id: `child-${index}`, agentId: 'helper', text: 'Bounded child' })) })
      await f.db.query("UPDATE lingxios.agent_work_items SET status='succeeded',finished_at=NOW() WHERE id=ANY($1::text[])", [graph.nodes.map(node => node.workId)])
    }
    const snapshot = (await f.app.readRunTrace(f.identity))!
    assert.equal(snapshot.truncated, true); assert.equal(snapshot.spans.filter(span => span.kind === 'agent').length, 32)
    assert.equal(snapshot.origin, null)
    assert.equal(snapshot.spans.find(span => span.kind === 'llm')!.inputTokens, null)
    // Simulate an old persisted event: it has no trustworthy start metadata.
    await f.db.query(`INSERT INTO lingxios.agent_run_events(run_id,seq,tenant_id,agent_id,kind,stage,visibility,data)
      VALUES($1,1,$2,$3,'run.started','started','user','{}')`, [work.id, work.tenantId, work.agentId])
    await f.db.query("UPDATE lingxios.agent_work_items SET status='waiting',finished_at=NULL WHERE id=$1", [work.id])
    const waiting = (await f.app.readRunTrace(f.identity))!
    assert.equal(waiting.spans[0]!.state, 'waiting'); assert.equal(waiting.spans[0]!.startedAt, null); assert.equal(waiting.spans[0]!.completedAt, null)
  } finally { await f.close() }
})
