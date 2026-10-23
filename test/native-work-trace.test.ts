import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { it } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS } from '../src/app/index.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import { actionKeyOf, sessionKeyOf } from '../src/protocol/types.js'
import { snapshotRequest } from '../src/context/request.js'
import { executionTraceMetadata } from '../src/protocol/run-trace.js'
import type { ToolDefinition } from '../src/tools/definition.js'
import { AgentRuntime } from '../src/runtime/runtime.js'
import { KernelCancelledError } from '../src/errors.js'

// Written before source: docs/public-run-trace/native-work-failure-model.md.
async function fixture(execute: ToolDefinition['execute'] = async () => ({ ok: true, value: 'PRIVATE-RESULT' }), effect: ToolDefinition['effect'] = 'read') {
  const db = new PGlite()
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  const pool: SqlPool = { query: async (sql, params) => {
    const r = await db.query<Record<string, unknown>>(sql, params)
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }
  }, connect: async () => ({ query: pool.query, release() {} }) }
  const app = await createLingxiOS({ database: pool, background: { role: 'passive' }, tools: [{
    action: 'probe.read', name: 'probe__read', description: 'Read synthetic data', effect, approval: false,
    parameters: { type: 'object', properties: {}, additionalProperties: false }, parse: () => ({}), authorize: async () => {}, execute,
  }] })
  const identity = { runId: 'native-trace', tenantId: 'tenant', agentId: 'agent', sessionId: 'session', principalId: 'human' }
  await app.enqueue({ ...identity, id: identity.runId, text: 'Read synthetic data', mode: 'execute', codeExecution: 'enabled' })
  const host = app.connectWorker({ workerId: 'native-trace-worker', workKinds: ['turn'] })
  const work = (await host.claimWork())!
  await host.saveSession(work, { key: sessionKeyOf(work), tenantId: work.tenantId, agentId: work.agentId,
    sessionId: work.sessionId, history: [], appliedWorkIds: [work.id], revision: 0, compactionEpoch: 0,
    request: snapshotRequest(await host.loadContext(work)) })
  const action = (cellId = 'cell', callIndex = 0) => {
    const key = { runId: work.id, cellId, callIndex }
    return { ...key, idempotencyKey: actionKeyOf(key), action: 'probe.read', args: {} }
  }
  return { db, pool, app, host, work, identity, action, close: async () => { await app.stop(); await db.close() } }
}

it('captures only actual Python lifecycle timing with bounded current request identity', () => {
  for (const kind of ['ipython.started', 'ipython.completed', 'ipython.failed', 'ipython.timeout', 'ipython.cancelled', 'ipython.waiting']) {
    const before = Date.now(), trace = executionTraceMetadata(kind, { name: 'ipython', requestVersion: 2, attemptId: 'attempt', at: 1 }, 2, 3)
    assert.ok(trace, kind); assert.ok(trace.at >= before); assert.equal(trace.requestVersion, 2); assert.equal(trace.fence, 3)
    assert.equal(trace.attemptId, 'attempt')
  }
  assert.equal(executionTraceMetadata('ipython.started', { name: 'probe__read', requestVersion: 1 }, 1, 1), undefined)
})

it('projects actual host dispatch live, then preserves its interval through cached recovery without duplicate cost', async () => {
  let enter!: () => void, release!: () => void, executions = 0
  const ready = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(async () => { executions++; enter(); await gate; return { ok: true, value: 'PRIVATE-RESULT' } })
  let operation: Promise<unknown> | undefined
  try {
    const action = f.action(); operation = f.host.executeAction(f.work, action)
    await ready
    const running = (await f.app.readRunTrace(f.identity))!, span = running.spans.find(s => s.name === 'probe.read')
    assert.ok(span, 'CP-only actions must appear without worker onHostAction hooks')
    assert.equal(span.state, 'running'); assert.ok(span.startedAt); assert.equal(span.completedAt, null)
    assert.equal(span.toolCallId, `host:${action.idempotencyKey}`); assert.equal(Reflect.get(span, 'stepId'), action.cellId)
    release(); await operation
    const first = (await f.app.readRunTrace(f.identity))!.spans.find(s => s.spanId === span.spanId)!
    assert.equal(first.state, 'complete'); assert.ok(first.completedAt! >= first.startedAt!)
    assert.deepEqual((await f.host.loadContext(f.work)).executionSteps?.filter(s => s.kind === 'runtime.action_trace'), [])
    await f.host.executeAction(f.work, action)
    await f.db.query('UPDATE lingxios.agent_work_items SET preempt_requested_at=NOW() WHERE id=$1', [f.work.id])
    await f.host.yieldWork(f.work)
    await f.db.query('UPDATE lingxios.agent_work_items SET available_at=NOW() WHERE id=$1', [f.work.id])
    const recovered = (await f.host.claimWork())!
    assert.notEqual(recovered.fence, f.work.fence)
    await f.host.executeAction(recovered, action)
    const replay = (await f.app.readRunTrace(f.identity))!
    assert.deepEqual(replay.spans.filter(s => s.kind === 'tool'), [first]); assert.equal(executions, 1)
    assert.equal(replay.spans.filter(s => s.kind === 'llm').length, 0)
    assert.equal(/PRIVATE-|arguments|inputSha256|code|leaseToken/.test(JSON.stringify(replay)), false)
    assert.equal(await f.app.readRunTrace({ ...f.identity, principalId: 'other' }), null)
  } finally { release(); await operation?.catch(() => {}); await f.close() }
})

it('deduplicates matching worker presentation hooks and records internal inspection and fresh resource checks', async () => {
  const f = await fixture()
  try {
    const action = f.action(), data = { toolCallId: `host:${action.idempotencyKey}`, name: action.action, requestVersion: 1, attemptId: 'model-attempt' }
    await f.host.emitEvent(f.work, { runId: f.work.id, seq: 1, kind: 'tool.started', stage: 'started', visibility: 'user', data })
    const result = await f.host.executeAction(f.work, action)
    await f.host.emitEvent(f.work, { runId: f.work.id, seq: 2, kind: 'tool.completed', stage: 'completed', visibility: 'user', data: { ...data, result: { status: result.ok ? 'completed' : 'failed' } } })
    const invoke = async (name: string, args: Record<string, unknown>, cellId: string) => {
      const key = { runId: f.work.id, cellId, callIndex: 0 }
      return f.host.executeAction(f.work, { ...key, idempotencyKey: actionKeyOf(key), action: name, args })
    }
    await invoke('task.inspect', {}, 'completion-inspect:1:1')
    await invoke('task.check_resource', { action: 'probe.read', args: {}, expected: { nonexistent: true } }, 'resource-review:1:1')
    const spans = (await f.app.readRunTrace(f.identity))!.spans.filter(s => s.kind === 'tool')
    assert.equal(spans.length, 3); assert.deepEqual(spans.map(s => s.name).sort(), ['probe.read', 'task.check_resource', 'task.inspect'])
    assert.equal(spans.find(s => s.name === 'probe.read')!.attemptId, 'model-attempt')
    assert.equal(spans.some(s => s.costMicros !== undefined || s.inputTokens !== undefined), false)
    await assert.rejects(f.host.saveStep(f.work, { id: 'forged', kind: 'runtime.action_trace', requestVersion: 1,
      input: { startedAt: 1 }, artifacts: [] }), /reserved/)
  } finally { await f.close() }
})

it('keeps post-effect trace failure from rewriting receipts and rejects pre-dispatch trace failure', async () => {
  let executions = 0
  const f = await fixture(async () => { executions++; return { ok: true, value: 'PRIVATE-RESULT' } })
  const query = f.pool.query.bind(f.pool)
  let fail: 'before' | 'after' | undefined = 'before'
  f.pool.query = async (sql, params) => {
    if (sql.includes('INSERT INTO lingxios.agent_steps') && params?.[5] === 'runtime.action_trace'
      && (fail === 'before' || fail === 'after' && params[8] !== null)) throw new Error('Synthetic trace storage failure')
    return query(sql, params)
  }
  try {
    await assert.rejects(f.host.executeAction(f.work, f.action('before')), /Synthetic trace storage failure/)
    assert.equal(executions, 0)
    fail = 'after'
    const action = f.action('after'), result = await f.host.executeAction(f.work, action)
    assert.equal(result.ok, true); assert.equal(executions, 1)
    fail = undefined
    assert.deepEqual(await f.host.executeAction(f.work, action), result)
    const spans = (await f.app.readRunTrace(f.identity))!.spans.filter(s => s.kind === 'tool')
    assert.equal(spans.length, 1); assert.equal(spans[0]!.state, 'unknown'); assert.equal(spans[0]!.completedAt, null)
  } finally { await f.close() }
})

it('records known no-dispatch on pre-marker failure so uncertain action recovery never invents an unknown effect', async () => {
  let executions = 0
  const f = await fixture(async () => { executions++; return { ok: true, value: 'PRIVATE-RESULT' } }, 'uncertain')
  const query = f.pool.query.bind(f.pool)
  f.pool.query = async (sql, params) => {
    if (sql.includes('INSERT INTO lingxios.agent_steps') && params?.[5] === 'runtime.action_trace') throw new Error('Synthetic trace storage failure')
    return query(sql, params)
  }
  try {
    const action = f.action(), refused = await f.host.executeAction(f.work, action)
    assert.equal(refused.ok, false); assert.equal(refused.executionState, 'no_effect')
    assert.deepEqual(await f.host.executeAction(f.work, action), refused); assert.equal(executions, 0)
    const pending = await f.db.query('SELECT intent FROM lingxios.agent_action_intents WHERE idempotency_key=$1', [action.idempotencyKey])
    assert.equal(pending.rows.length, 1)
    const receipts = await f.db.query<{ result: { executionState: string } }>('SELECT result FROM lingxios.agent_action_ledger WHERE idempotency_key=$1', [action.idempotencyKey])
    assert.equal(receipts.rows[0]!.result.executionState, 'no_effect')
    assert.equal((await f.app.readRunTrace(f.identity))!.spans.filter(s => s.kind === 'tool').length, 0)
  } finally { await f.close() }
})

for (const ok of [true, false]) it(`preserves actual action status when cancellation arrives after execution during receipt persistence (ok=${ok})`, async () => {
  const f = await fixture(async () => ok ? { ok: true, value: 'PRIVATE-RESULT' } : { ok: false, executionState: 'no_effect', error: 'PRIVATE-ERROR' })
  const abort = new AbortController(), query = f.pool.query.bind(f.pool)
  f.pool.query = async (sql, params) => {
    const result = await query(sql, params)
    if (sql.includes('INSERT INTO lingxios.agent_action_ledger')) abort.abort(new Error('Synthetic late cancellation'))
    return result
  }
  try {
    const result = await f.host.executeAction(f.work, f.action(), abort.signal)
    assert.equal(result.ok, ok)
    const span = (await f.app.readRunTrace(f.identity))!.spans.find(s => s.kind === 'tool')!
    assert.equal(span.state, ok ? 'complete' : 'failed'); assert.ok(span.completedAt! >= span.startedAt!)
  } finally { await f.close() }
})

it('keeps real parallel dispatches and a safe retry after lost receipt distinct without replaying a cached effect', async () => {
  let executions = 0, enter!: () => void, release!: () => void
  const ready = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(async () => { if (++executions === 2) enter(); await gate; return { ok: true, value: 'PRIVATE-RESULT' } })
  const query = f.pool.query.bind(f.pool)
  let loseReceipt = true
  f.pool.query = async (sql, params) => {
    if (loseReceipt && sql.includes('INSERT INTO lingxios.agent_action_ledger')) { loseReceipt = false; throw new Error('Synthetic lost receipt write') }
    return query(sql, params)
  }
  let pending: Promise<PromiseSettledResult<unknown>[]> | undefined
  try {
    const a = f.action('parallel', 0), b = f.action('parallel', 1)
    pending = Promise.allSettled([f.host.executeAction(f.work, a), f.host.executeAction(f.work, b)])
    await ready
    const live = (await f.app.readRunTrace(f.identity))!.spans.filter(s => s.kind === 'tool')
    assert.equal(live.length, 2); assert.equal(new Set(live.map(s => s.spanId)).size, 2)
    assert.ok(live.every(s => s.state === 'running' && s.completedAt === null && s.startedAt !== null))
    release()
    const results = await pending
    assert.equal(results.filter(r => r.status === 'rejected').length, 1)
    const failed = results[0]!.status === 'rejected' ? a : b
    await f.host.executeAction(f.work, failed)
    await f.host.executeAction(f.work, failed)
    assert.equal(executions, 3, 'only the missing read receipt permits actual redispatch; the settled retry is cached')
    const spans = (await f.app.readRunTrace(f.identity))!.spans.filter(s => s.kind === 'tool')
    assert.equal(spans.length, 3); assert.equal(new Set(spans.map(s => s.spanId)).size, 3)
    assert.deepEqual(spans.map(s => s.state).sort(), ['complete', 'complete', 'unknown'])
    assert.equal(spans.filter(s => s.completedAt === null).length, 1, 'lost receipt cannot fabricate the old attempt end')
    assert.equal(spans.filter(s => s.toolCallId === `host:${failed.idempotencyKey}`).length, 2)
    assert.equal(spans.some(s => s.costMicros !== undefined || s.inputTokens !== undefined), false)
  } finally { release(); await pending; await f.close() }
})

it('does not trace denied or cancelled action admission as actual dispatch', async () => {
  let executions = 0
  const f = await fixture(async () => { executions++; return { ok: true } })
  try {
    const denied = await f.host.executeAction(f.work, { ...f.action(), action: 'private.read' })
    assert.equal(denied.ok, false)
    assert.equal((await f.app.readRunTrace(f.identity))!.spans.filter(s => s.kind === 'tool').length, 0)
    await f.app.cancel(f.identity)
    await assert.rejects(f.host.executeAction(f.work, f.action()), /cancel/)
    assert.equal(executions, 0)
    assert.equal((await f.app.readRunTrace(f.identity))!.spans.filter(s => s.kind === 'tool').length, 0)
  } finally { await f.close() }
})

it('persists actual runtime Python cancellation after lifecycle abort without bypassing CP fencing', { timeout: 30000 }, async () => {
  const f = await fixture()
  try {
    const usage = { available: true, inputTokens: 10, outputTokens: 5 }
    const runtime = new AgentRuntime(f.host, {
      async compact() { throw new Error('Unexpected compaction') },
      async structured() { throw new Error('Unexpected semantic review') },
      async run() { return { text: '', usage, output: [{ type: 'function_call', callId: 'cancel-python', name: 'ipython', arguments: '{"code":"PRIVATE-CODE"}' }] } },
    }, { async execute(_work, _run, cellId, _code, signal) {
      await f.app.cancel(f.identity)
      return new Promise((_, reject) => {
        const cancelled = () => reject(new KernelCancelledError(cellId))
        if (signal!.aborted) cancelled(); else signal!.addEventListener('abort', cancelled, { once: true })
      })
    } }, { heartbeatMs: 20 })
    await runtime.runWork(f.work)
    const state = await f.app.readRunState(f.identity)
    assert.equal(state!.run.status, 'cancelled')
    const snapshot = (await f.app.readRunTrace(f.identity))!, python = snapshot.spans.find(s => s.name === 'ipython')!
    assert.ok(python); assert.equal(python.state, 'cancelled'); assert.ok(python.completedAt! >= python.startedAt!)
    assert.equal(python.toolCallId, 'cancel-python'); assert.equal(python.requestVersion, 1); assert.equal(python.fence, f.work.fence)
    assert.equal(snapshot.spans.filter(s => s.kind === 'llm').length, 1)
    assert.equal(/PRIVATE-|code|inputSha256/.test(JSON.stringify(snapshot)), false)
    await assert.rejects(f.host.emitEvent(f.work, { runId: f.work.id, seq: 99999, kind: 'ipython.cancelled', stage: 'cancelled', visibility: 'internal', data: {} }), /lease/)
  } finally { await f.close() }
})

it('projects Python parents, parallel failed/timeout/cancelled cells and replay without exposing raw diagnostics', async () => {
  const f = await fixture()
  try {
    let seq = 0
    const emit = (kind: string, data: Record<string, unknown>, stage: 'started' | 'completed' | 'failed' | 'cancelled') =>
      f.host.emitEvent(f.work, { runId: f.work.id, seq: ++seq, kind, stage, visibility: 'internal', data: {
        name: 'ipython', requestVersion: 1, attemptId: 'model-attempt', inputSha256: 'PRIVATE-HASH', code: 'PRIVATE-CODE', output: 'PRIVATE-RESULT', ...data,
      } })
    for (const callId of ['parent', 'parallel', 'timeout', 'cancelled', 'approval']) await emit('ipython.started', { callId, stepId: callId }, 'started')
    await f.host.executeAction(f.work, f.action('parent'))
    await emit('ipython.completed', { callId: 'parent', stepId: 'parent', artifacts: [] }, 'completed')
    await emit('ipython.failed', { callId: 'parallel', stepId: 'parallel', error: 'PRIVATE-ERROR' }, 'failed')
    await emit('ipython.timeout', { callId: 'timeout', stepId: 'timeout' }, 'failed')
    await emit('ipython.cancelled', { callId: 'cancelled', stepId: 'cancelled' }, 'cancelled')
    await emit('ipython.waiting', { callId: 'approval', stepId: 'approval' }, 'completed')
    await emit('ipython.started', { name: 'probe__read', callId: 'direct', stepId: 'direct' }, 'started')
    const snapshot = (await f.app.readRunTrace(f.identity))!, python = snapshot.spans.filter(s => s.name === 'ipython')
    assert.equal(python.length, 5)
    assert.deepEqual(python.map(s => s.state).sort(), ['cancelled', 'complete', 'failed', 'failed', 'waiting'])
    const child = snapshot.spans.find(s => s.name === 'probe.read')!, parent = python.find(s => s.toolCallId === 'parent')!
    assert.equal(child.parentSpanId, parent.spanId); assert.ok(child.startedAt! >= parent.startedAt!)
    assert.equal(parent.timingBasis, 'python-execution'); assert.equal(Reflect.get(parent, 'stepId'), 'parent')
    assert.equal(/PRIVATE-|code|output|inputSha256|error/.test(JSON.stringify(snapshot)), false)
    assert.deepEqual(await f.app.readRunTrace(f.identity), snapshot)
    await f.host.completeWork(f.work, { status: 'cancelled' })
    const response = await f.app.streamRun(f.identity, { trace: true, lastEventId: '99999' })
    const wire = await response.text()
    assert.ok(wire.includes(parent.spanId)); assert.equal(wire.includes('PRIVATE-'), false)
  } finally { await f.close() }
})
