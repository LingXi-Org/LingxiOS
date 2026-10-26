import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS, type RuntimeFailureDiagnostic } from '../src/index.js'
import { createWorker } from '../src/worker/index.js'
import { DefaultRuntimePolicy } from '../src/runtime/policy.js'
import { AgentRuntime } from '../src/runtime/runtime.js'
import { projectRuntimeFailure, readRuntimeFailureDiagnostic } from '../src/runtime/failure-diagnostics.js'
import { createLogger, nullLogger } from '../src/logging.js'
import { RunCancelledError } from '../src/errors.js'
import { releaseVersions } from '../src/versions.js'
import { PublicTextPublicationError } from '../src/runtime/public-text.js'
import { modelFailure } from '../src/model/recovery.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'

const secret = 'PRIVATE_BODY_QUERY_TOKEN_SENTINEL'
const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))
const mappedRoot = sourceRoot.endsWith('/dist/src/') ? sourceRoot.slice(0, -'dist/src/'.length) + 'src/' : sourceRoot
const unexpected = async (): Promise<never> => { throw new Error('unexpected model/kernel invocation') }

it('publication diagnostics retain only closed stage/code and safe cause classification without enabling retries', () => {
  const error = new PublicTextPublicationError('delta', 'persistence_rejected', Object.assign(new Error(secret), { code: '23514', token: secret }))
  const projected = projectRuntimeFailure(error, { runId: 'synthetic-publication', fence: 1 },
    { phase: 'turn_execution', bindingState: 'saved', requestVersion: 1, continuationReason: 'intermediate_outcome_null' })
  assert.deepEqual(projected.publicationFailure, { stage: 'delta', code: 'persistence_rejected' })
  assert.equal(projected.sqlState, '23514')
  assert.equal(modelFailure(error).retryable, false)
  assert.equal(modelFailure(new PublicTextPublicationError('delta', 'persistence_rejected', Object.assign(new Error(secret), { code: 'ECONNRESET' }))).retryable, false)
  assert.deepEqual(readRuntimeFailureDiagnostic(projected), projected)
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_BODY_QUERY_TOKEN_SENTINEL/)
  for (const publicationFailure of [{ stage: secret, code: 'persistence_rejected' }, { stage: 'seal', code: secret },
    { stage: 'seal', code: 'persistence_rejected', message: secret }]) {
    assert.equal(readRuntimeFailureDiagnostic({ ...projected, publicationFailure }), null)
  }
  assert.equal(readRuntimeFailureDiagnostic({ ...projected, continuationReason: secret }), null)
})
function failure() {
  return Object.assign(new TypeError(secret), { code: '42P01', query: secret,
    cause: { code: 'ETIMEDOUT', status: 503, message: secret, token: secret },
    stack: `TypeError: ${secret}\n    at ${secret} (${sourceRoot}runtime/runtime.js:88:19)\n`
      + `    at mapped (${mappedRoot}context/request.ts:42:7)\n`
      + `    at spoof (/private/${secret}/src/runtime/runtime.js:1:2)\n    at query (${sourceRoot}runtime/runtime.js?token=${secret}:1:2)` })
}

async function fixture(mode: 'execution_snapshot' | 'session_restore' | 'binding_save' | 'diagnostic_write' | 'cancelled' | 'revision') {
  const db = new PGlite(), home = await mkdtemp(join(tmpdir(), 'runtime-failure-'))
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  let tail = Promise.resolve()
  const acquire = async () => { let release!: () => void; const previous = tail; tail = new Promise<void>(resolve => { release = resolve }); await previous; return release }
  const query: SqlPool['query'] = async (sql, params) => { const result = await db.query<Record<string, unknown>>(sql, params); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length } }
  const pool: SqlPool = { async query(sql, params) { const release = await acquire(); try { return await query(sql, params) } finally { release() } },
    async connect() { return { query, release: await acquire() } } }
  const logs: string[] = []
  let rejectedDiagnostic: Record<string, unknown> | undefined, revised = false
  const app = await createLingxiOS({ database: pool, homesRoot: home, background: { role: 'passive' }, logger: nullLogger,
    contextProvider: { loadContext: async work => ({ persona: { name: 'Fixture', role: 'assistant', instructions: '' }, capabilities: ['memory'],
      messages: [{ ref: work.triggerRef, authorId: work.principalId!, authorName: 'Fixture', authorKind: 'human', body: 'Hello', createdAt: 'now' }] }) } })
  class Policy extends DefaultRuntimePolicy {
    override kernelCapabilities(context: Parameters<DefaultRuntimePolicy['kernelCapabilities']>[0]) {
      if (mode === 'execution_snapshot' || mode === 'diagnostic_write') throw failure()
      if (mode === 'cancelled') throw new RunCancelledError('fixture')
      return super.kernelCapabilities(context)
    }
    override productRules(...args: Parameters<DefaultRuntimePolicy['productRules']>) {
      if (mode === 'session_restore') throw failure()
      return super.productRules(...args)
    }
  }
  const identity = { runId: `failure-${mode}`, tenantId: 'tenant', principalId: 'human', agentId: 'agent', sessionId: 'session' }
  const worker = createWorker({ controlPlane: { connectWorker(input) {
    const host = app.connectWorker(input), save = host.saveStep.bind(host), emit = host.emitEvent.bind(host), saveSession = host.saveSession.bind(host)
    return { ...host,
      saveSession: async (work, session, signal) => {
        if (mode === 'revision' && session.request?.revisions.length === 1) throw failure()
        await saveSession(work, session, signal)
        if (mode === 'revision' && !revised) { revised = true; assert.equal(await app.revise(identity, 'Hello again'), true) }
      },
      saveStep: async (work, step, signal) => {
        if (mode === 'binding_save' && step.kind === 'runtime.binding') { await Promise.resolve(); throw failure() }
        await save(work, step, signal)
      },
      emitEvent: async (work, event, signal) => {
        if (event.kind === 'runtime.failure') {
          if (mode === 'diagnostic_write') { rejectedDiagnostic = structuredClone(event.data); throw new Error(secret) }
          await assert.rejects(emit(work, { ...event, visibility: 'user' }, signal), /invalid runtime failure diagnostic/)
          await assert.rejects(emit(work, { ...event, data: { ...event.data, message: secret } }, signal), /invalid runtime failure diagnostic/)
          await assert.rejects(emit(work, { ...event, data: { ...event.data, fence: work.fence + 1 } }, signal), /invalid runtime failure diagnostic/)
        }
        await emit(work, event, signal)
      } }
  } }, policy: new Policy(), deploymentVersion: 'b'.repeat(40), logger: createLogger({ sink: line => logs.push(line) }),
    kernelFactory: () => ({ execute: unexpected, close() {}, size: 0 }),
    model: { modelId: 'fixture', run: unexpected, structured: unexpected, compact: unexpected } })
  await app.enqueue({ id: identity.runId, ...identity, text: 'Hello', mode: 'chat', codeExecution: 'disabled' })
  return { app, worker, identity, pool, logs, rejectedDiagnostic: () => rejectedDiagnostic,
    async close() { await worker.stop(); await app.stop(); await db.close(); await rm(home, { recursive: true, force: true }) } }
}

for (const phase of ['execution_snapshot', 'session_restore', 'binding_save'] as const)
  it(`persists an internal, content-free failure after input.loaded at ${phase}`, async () => {
    const f = await fixture(phase)
    try {
      assert.equal(await f.worker.runNext(), true)
      const state = await f.app.readRun(f.identity)
      assert.equal(state?.status, 'failed')
      assert.equal(state?.error, 'Runtime operation failed')
      const events = (await f.pool.query('SELECT kind,visibility,data FROM lingxios.agent_run_events WHERE run_id=$1 ORDER BY seq', [f.identity.runId])).rows
      assert.deepEqual(events.map(event => event['kind']), ['run.started', 'input.loaded', 'runtime.failure', 'run.failed'])
      const failure = events[2]!
      assert.equal(failure['visibility'], 'internal')
      assert.equal((await f.pool.query('SELECT * FROM lingxios.agent_steps WHERE work_id=$1', [f.identity.runId])).rows.length, 0)
      const diagnostic = (await f.app.readDiagnostics(f.identity))!.runtimeFailure!
      assert.deepEqual(diagnostic, failure['data'])
      assert.equal(diagnostic.phase, phase)
      assert.equal(diagnostic.bindingState, phase === 'binding_save' ? 'saving' : 'not_started')
      assert.equal(diagnostic.runId, f.identity.runId)
      assert.equal(diagnostic.requestVersion, 1)
      assert.equal(diagnostic.fence, 1)
      assert.equal(diagnostic.runtimeVersion, releaseVersions.runtime)
      assert.equal(diagnostic.deploymentVersion, 'b'.repeat(40))
      assert.match(diagnostic.correlationId, /^[0-9a-f-]{36}$/)
      assert.equal(diagnostic.errorName, 'TypeError')
      assert.equal(diagnostic.sqlState, '42P01')
      assert.equal(diagnostic.causeCode, 'ETIMEDOUT')
      assert.equal(diagnostic.reason, 'dependency_unavailable')
      assert.equal(diagnostic.httpStatus, 503)
      assert.deepEqual(diagnostic.frames, [{ module: 'runtime/runtime.js', line: 88, column: 19 },
        { module: 'context/request.ts', line: 42, column: 7 }])
      const publicEvents = (await f.app.readEvents(f.identity)).events
      assert.deepEqual(publicEvents.map(event => event.kind), ['run.started', 'run.failed'])
      assert.deepEqual(publicEvents[1]!.data, { error: 'Operation failed; inspect the structured status' })
      assert.doesNotMatch(JSON.stringify({ events, publicEvents, state, logs: f.logs }), /PRIVATE_|\/private\/|message|rawStack|query|token/)
      assert.equal(await f.app.readDiagnostics({ ...f.identity, tenantId: 'other' }), null)
      await f.pool.query('UPDATE lingxios.agent_work_items SET fence=2 WHERE id=$1', [f.identity.runId])
      assert.equal((await f.app.readDiagnostics(f.identity))!.runtimeFailure, null, 'earlier fence diagnostics cannot describe the current attempt')
      await f.pool.query(`UPDATE lingxios.agent_work_items SET fence=1,steer_inputs='[{"id":"revision","text":"Hello again","createdAt":"now"}]'::jsonb WHERE id=$1`, [f.identity.runId])
      assert.equal((await f.app.readDiagnostics(f.identity))!.runtimeFailure, null, 'earlier request diagnostics cannot describe the current request')
    } finally { await f.close() }
  })

it('a failed diagnostic sink preserves failure completion, and cancellation remains unchanged', async () => {
  for (const mode of ['diagnostic_write', 'cancelled'] as const) {
    const f = await fixture(mode)
    try {
      await f.worker.runNext()
      assert.equal((await f.app.readRun(f.identity))?.status, mode === 'cancelled' ? 'cancelled' : 'failed')
      assert.equal((await f.app.readDiagnostics(f.identity))!.runtimeFailure, null)
      if (mode === 'diagnostic_write') {
        const fallback = f.logs.map(line => JSON.parse(line)).find(line => line.code === 'runtime_failure_diagnostic_unavailable')
        assert.ok(fallback)
        assert.deepEqual(fallback.diagnostic, f.rejectedDiagnostic(), 'logging retains the same safe diagnostic and correlation ID')
        assert.ok(readRuntimeFailureDiagnostic(fallback.diagnostic))
      }
      assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE_/)
    } finally { await f.close() }
  }
})

it('a failure after accepting steering is persisted and readable for the current request version', async () => {
  const f = await fixture('revision')
  try {
    assert.equal(await f.worker.runNext(), true)
    const diagnostics = (await f.app.readDiagnostics(f.identity))!
    assert.equal(diagnostics.run.status, 'failed')
    assert.equal(diagnostics.run.requestVersion, 2)
    assert.equal(diagnostics.runtimeFailure?.requestVersion, 2)
    assert.equal(diagnostics.runtimeFailure.phase, 'turn_execution')
    assert.equal(diagnostics.runtimeFailure.bindingState, 'saved')
    const stored = (await f.pool.query("SELECT data FROM lingxios.agent_run_events WHERE run_id=$1 AND kind='runtime.failure'", [f.identity.runId])).rows
    assert.deepEqual(stored[0]?.['data'], diagnostics.runtimeFailure)
    assert.equal((await f.app.readEvents(f.identity)).events.some(event => event.kind === 'runtime.failure'), false)
    assert.doesNotMatch(JSON.stringify({ stored, logs: f.logs }), /PRIVATE_/)
  } finally { await f.close() }
})

it('diagnostic projection and stored validation reject arbitrary names, codes, paths and secrets', () => {
  const location = { phase: 'session_restore', bindingState: 'not_started', requestVersion: 1 } as const
  const identity = { runId: 'failure', fence: 1 }
  const diagnostic = projectRuntimeFailure(failure(), identity, location, 'unknown')
  const unsafe = projectRuntimeFailure({ name: secret, code: 'TOKEN', status: '503', cause: { code: 'EACCES', message: secret } }, identity, location)
  assert.equal(unsafe.errorName, 'UnknownError')
  assert.equal(unsafe.systemCode, 'EACCES')
  assert.equal(unsafe.sqlState, undefined)
  assert.equal(unsafe.httpStatus, undefined)
  assert.deepEqual(unsafe.frames, [])
  assert.doesNotMatch(JSON.stringify(unsafe), /PRIVATE_/)
  assert.doesNotThrow(() => projectRuntimeFailure(new Proxy({}, { get() { throw new Error(secret) } }), identity, location))
  for (const invalid of [
    { ...diagnostic, message: secret }, { ...diagnostic, errorName: secret }, { ...diagnostic, reason: secret },
    { ...diagnostic, causeCode: secret }, { ...diagnostic, correlationId: secret }, { ...diagnostic, sqlState: 'TOKEN' },
    { ...diagnostic, deploymentVersion: secret }, { ...diagnostic, runtimeVersion: secret }, { ...diagnostic, phase: secret },
    { ...diagnostic, bindingState: secret }, { ...diagnostic, systemCode: secret }, { ...diagnostic, httpStatus: '503' },
    { ...diagnostic, frames: [{ module: '/private/' + secret, line: 1 }] },
    { ...diagnostic, frames: [{ module: 'runtime/runtime.js', line: 1, body: secret }] },
  ]) assert.equal(readRuntimeFailureDiagnostic(invalid), null)
  const safe: RuntimeFailureDiagnostic | null = readRuntimeFailureDiagnostic(diagnostic)
  assert.deepEqual(safe, diagnostic)
  assert.notEqual(safe, diagnostic)
  assert.notEqual(safe!.frames, diagnostic.frames)
  assert.throws(() => new AgentRuntime({} as never, {} as never, {} as never, { deploymentVersion: secret }), /deploymentVersion/)
})
