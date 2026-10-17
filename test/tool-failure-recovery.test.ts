import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import type { ActionExecutionOptions } from '../src/control-plane/stores.js'
import type { HostAction, WorkItem } from '../src/protocol/types.js'
import { NoEffectError, type ToolDefinition } from '../src/tools/definition.js'
import { toolExecutor } from '../src/tools/executor.js'
import { toolContractHash } from '../src/tools/contracts.js'
import { classifyToolFailure, type ToolFailureDiagnostics } from '../src/tools/failure.js'

const secret = 'secret-prompt credential protected-resource-id'
const work: Omit<WorkItem, 'leaseToken'> = { id: 'work', tenantId: 'tenant', agentId: 'agent', sessionId: 'session',
  principalId: 'principal', fence: 1, homeEpoch: 1, kind: 'turn', lane: 'interactive', triggerRef: 'message' }
const action: HostAction = { runId: 'work', cellId: 'cell', callIndex: 0, action: 'documents.read', args: {}, idempotencyKey: 'action' }
const options = (): ActionExecutionOptions => ({ requestVersion: 1, signal: new AbortController().signal,
  deadlineAt: new Date(Date.now() + 30_000).toISOString() })
function fixture() {
  let authorizations = 0, executions = 0, commits = 0, rollbacks = 0, releases = 0
  let authorize: () => Promise<void> = async () => {}
  let execute: () => Promise<void> = async () => {}
  let commit: () => Promise<void> = async () => {}
  let rollback: () => Promise<void> = async () => {}
  const tool: ToolDefinition = { name: 'documents__read', action: 'documents.read', description: 'Read',
    effect: 'read', approval: false, parameters: { type: 'object', properties: {}, additionalProperties: false },
    parse: () => ({}), authorize: async () => { authorizations++; await authorize() },
    execute: async () => { executions++; await execute(); return { ok: true, value: {} } } }
  const pool: SqlPool = {
    async query(sql) {
      if (sql === 'COMMIT') { commits++; await commit() }
      if (sql === 'ROLLBACK') { rollbacks++; await rollback() }
      return { rows: sql.includes('SELECT intent') ? [{ intent: { toolContractHash: toolContractHash(tool) } }]
        : sql.includes('SELECT work.id') ? [{ id: work.id }] : [], rowCount: 0 }
    }, connect: async () => ({ query: pool.query, release() { releases++ } }),
  }
  return { tool, executor: toolExecutor(pool, [tool]), counts: () => ({ authorizations, executions, commits, rollbacks, releases }),
    authorize: (fn: typeof authorize) => { authorize = fn }, execute: (fn: typeof execute) => { execute = fn },
    commit: (fn: typeof commit) => { commit = fn }, rollback: (fn: typeof rollback) => { rollback = fn } }
}
async function failure(operation: Promise<unknown>, code: string, category: string, recovery = 'none') {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof NoEffectError)
    assert.equal(error.code, code)
    const diagnostics = (error as NoEffectError & { diagnostics?: Record<string, unknown> }).diagnostics
    assert.equal(diagnostics?.['category'], category)
    assert.equal(diagnostics?.['recovery'], recovery)
    assert.match(String(diagnostics?.['correlationId']), /^[0-9a-f-]{36}$/)
    assert.ok(!JSON.stringify({ message: error.message, diagnostics }).includes(secret))
    return true
  })
}
it('keeps structured denials and blocked dependencies terminal without exposing their messages', async () => {
  for (const [error, code, category] of [
    [Object.assign(new Error(secret), { code: 'forbidden' }), 'forbidden', 'authorization'],
    [Object.assign(new Error(secret), { status: 403 }), 'forbidden', 'authorization'],
    [Object.assign(new Error(secret), { name: 'ForbiddenError', status: 404 }), 'forbidden', 'authorization'],
    [Object.assign(new Error(secret), { code: 'ETIMEDOUT', cause: { status: 401 } }), 'forbidden', 'authorization'],
    [Object.assign(new Error(secret), { code: 'dns_blocked' }), 'dependency_blocked', 'dependency'],
    [Object.assign(new Error(secret), { code: 'ENOTFOUND' }), 'dependency_unavailable', 'dependency'],
    [Object.assign(new Error(secret), { code: 'unknown-secret-code' }), 'authorization_unavailable', 'unknown'],
  ] as const) {
    const f = fixture(); f.authorize(async () => { throw error })
    await failure(f.executor.prepare(work, action, options()), code, category)
    assert.equal(f.counts().authorizations, 1); assert.equal(f.counts().executions, 0)
  }
})
it('bounds transient read-only authorization retries and preserves terminal version/input failures', async () => {
  const f = fixture(); f.authorize(async () => { throw Object.assign(new Error(secret), { code: 'EAI_AGAIN' }) })
  await failure(f.executor.prepare(work, action, options()), 'dependency_unavailable', 'dependency', 'retry')
  assert.equal(f.counts().authorizations, 2); assert.equal(f.counts().executions, 0)
  for (const code of ['tool_contract_changed', 'approval_stale', 'observation_required']) {
    const stale = fixture(); stale.authorize(async () => { throw new NoEffectError(secret, code) })
    await failure(stale.executor.prepare(work, action, options()), code, 'version', 'refresh')
    assert.equal(stale.counts().authorizations, 1)
  }
  const invalid = fixture(); invalid.tool.parse = () => { throw new Error(secret) }
  await failure(invalid.executor.prepare(work, action, options()), 'invalid_arguments', 'invalid_input')
  assert.equal(invalid.counts().authorizations, 0)
})
it('stops authorization recovery on cancellation and succeeds only after actual authorization', async () => {
  const f = fixture(); f.authorize(async () => { if (f.counts().authorizations === 1) throw { code: 'ECONNRESET' } })
  await f.executor.prepare(work, action, options()); assert.equal(f.counts().authorizations, 2)
  const controller = new AbortController(); const cancelled = fixture()
  cancelled.authorize(async () => { controller.abort(); throw { code: 'EAI_AGAIN' } })
  await failure(cancelled.executor.prepare(work, action, { ...options(), signal: controller.signal }), 'tool_cancelled', 'cancelled')
  assert.equal(cancelled.counts().authorizations, 1)
  const pauseController = new AbortController(), pause = fixture()
  pause.authorize(async () => { setImmediate(() => pauseController.abort()); throw { code: 'ECONNRESET' } })
  await failure(pause.executor.prepare(work, action, { ...options(), signal: pauseController.signal }), 'tool_cancelled', 'cancelled')
  assert.equal(pause.counts().authorizations, 1, 'cancellation interrupts the bounded recovery delay')
  const expired = fixture()
  await failure(expired.executor.prepare(work, action, { ...options(), deadlineAt: new Date(0).toISOString() }), 'tool_cancelled', 'cancelled')
  assert.equal(expired.counts().authorizations, 0)
})
it('retries only acknowledged serialization rollbacks and rechecks authorization on the same action', async () => {
  for (const code of ['40001', '40P01']) {
    const f = fixture(); f.tool.effect = 'transaction'
    f.execute(async () => { if (f.counts().executions === 1) throw Object.assign(new Error(secret), { code }) })
    assert.equal((await f.executor.execute(work, action, options())).ok, true)
    assert.equal(f.counts().executions, 2); assert.equal(f.counts().authorizations, 2)
    assert.equal(f.counts().commits, 1); assert.equal(f.counts().rollbacks, 1)
    assert.equal(f.counts().releases, 2)
    const exhausted = fixture(); exhausted.tool.effect = 'transaction'; exhausted.execute(async () => { throw { code } })
    await failure(exhausted.executor.execute(work, action, options()), 'transaction_rolled_back', 'dependency', 'retry')
    assert.equal(exhausted.counts().executions, 2)
  }
  const authorization = fixture(); authorization.tool.effect = 'transaction'
  authorization.authorize(async () => { if (authorization.counts().authorizations === 1) throw { code: '40001' } })
  assert.equal((await authorization.executor.execute(work, action, options())).ok, true)
  assert.equal(authorization.counts().authorizations, 2); assert.equal(authorization.counts().executions, 1)
  const revoked = fixture(); revoked.tool.effect = 'transaction'
  revoked.execute(async () => { throw { code: '40001' } })
  revoked.authorize(async () => { if (revoked.counts().authorizations === 2) throw { status: 403 } })
  await failure(revoked.executor.execute(work, action, options()), 'forbidden', 'authorization')
  assert.equal(revoked.counts().executions, 1)
})
it('never retries unknown write effects, lost commit acknowledgement, or failed rollback', async () => {
  const external = fixture(); external.tool.effect = 'uncertain'; external.execute(async () => { throw { code: 'ECONNRESET' } })
  await assert.rejects(external.executor.execute(work, action, options()))
  assert.equal(external.counts().executions, 1)
  const commit = fixture(); commit.tool.effect = 'transaction'; commit.commit(async () => { throw { code: '40001' } })
  await assert.rejects(commit.executor.execute(work, action, options()))
  assert.equal(commit.counts().executions, 1); assert.equal(commit.counts().rollbacks, 0)
  const rollback = fixture(); rollback.tool.effect = 'transaction'; rollback.execute(async () => { throw { code: '40001' } })
  rollback.rollback(async () => { throw new Error(secret) })
  await assert.rejects(rollback.executor.execute(work, action, options()))
  assert.equal(rollback.counts().executions, 1)
  const unknown = fixture(); unknown.tool.effect = 'transaction'; unknown.execute(async () => { throw new Error(secret) })
  await failure(unknown.executor.execute(work, action, options()), 'transaction_rolled_back', 'unknown')
  assert.equal(unknown.counts().executions, 1)
  const knownNoEffect = fixture(); knownNoEffect.tool.effect = 'uncertain'
  knownNoEffect.execute(async () => { throw new NoEffectError(secret, 'forbidden') })
  const result = await knownNoEffect.executor.execute(work, action, options())
  assert.equal(result.executionState, 'no_effect'); assert.equal(result.code, 'forbidden')
  assert.equal((result as unknown as { diagnostics: ToolFailureDiagnostics }).diagnostics.category, 'authorization')
  assert.ok(!JSON.stringify(result).includes(secret))
})
it('uses only allowlisted structured diagnostics across nested wrappers and serialization', () => {
  const correlationId = 'fe3ae295-14a9-4f8f-aee5-17cae5c1f480'
  const diagnostics = { category: 'dependency', retryable: true, recovery: 'retry', correlationId,
    causeCode: '40001', resourceId: secret, request: secret } as ToolFailureDiagnostics
  const wrapped = new NoEffectError(secret, 'dependency_unavailable', diagnostics)
  const serialized = JSON.parse(JSON.stringify(wrapped)) as unknown
  const classified = classifyToolFailure(serialized, 'transaction')
  assert.equal(classified.diagnostics.causeCode, '40001')
  assert.equal(classified.diagnostics.correlationId, correlationId)
  assert.equal(classified.diagnostics.retryable, true)
  assert.ok(!JSON.stringify(classified).includes(secret))
  assert.ok(!JSON.stringify(wrapped.diagnostics).includes(secret))
  const terminal = classifyToolFailure({ code: 'dependency_unavailable', diagnostics: { ...diagnostics, retryable: false } }, 'execution')
  assert.equal(terminal.diagnostics.retryable, false)
  const blocked = classifyToolFailure({ code: 'EAI_AGAIN', cause: { code: 'dns_blocked', message: secret } }, 'authorization')
  assert.equal(blocked.code, 'dependency_blocked'); assert.equal(blocked.diagnostics.retryable, false)
  assert.equal(classifyToolFailure(new Error('forbidden'), 'authorization').diagnostics.category, 'unknown')
  const hostile = Object.create(null) as Record<string, unknown>
  Object.defineProperty(hostile, 'code', { get() { throw new Error(secret) } })
  hostile['cause'] = hostile
  assert.equal(classifyToolFailure(hostile, 'authorization').diagnostics.category, 'unknown')
  const invalidDiagnostics = { ...diagnostics, causeCode: secret, correlationId: secret } as ToolFailureDiagnostics
  assert.ok(!JSON.stringify(new NoEffectError('safe', 'native_rejected', invalidDiagnostics).diagnostics).includes(secret))
})
