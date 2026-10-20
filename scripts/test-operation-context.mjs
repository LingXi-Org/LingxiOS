import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { createLingxiOS } from '../dist/src/index.js'

const connectionString = process.env.LINGXIOS_OPERATION_TEST_DATABASE_URL
if (!connectionString) throw new Error('LINGXIOS_OPERATION_TEST_DATABASE_URL must name an empty disposable database')
const appName = `lingxios-operation-${process.pid}`
const pool = new Pool({ connectionString, max: 1, application_name: appName, connectionTimeoutMillis: 1000 })
const observer = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 1000 })
const policy = { tenantId: 'operation-test', conversationId: 'room', version: 1, kind: 'group',
  owner: { kind: 'participant', id: 'human' }, defaultAgentId: 'agent', participants: [
    { id: 'human', kind: 'human', capabilities: ['read', 'execute'] },
    { id: 'agent', kind: 'agent', capabilities: ['read', 'execute', 'speak'] }] }
const message = { tenantId: policy.tenantId, conversationId: policy.conversationId, policyVersion: 1,
  messageId: 'stable-message', version: 1, author: { id: 'human', kind: 'human' }, text: 'Synthetic local acceptance.' }
const identity = { runId: 'missing', tenantId: policy.tenantId, principalId: 'human', agentId: 'agent', sessionId: 'session' }
const results = []
let control, acquisitions = 0
pool.on('acquire', () => acquisitions++)
async function until(predicate, budget = 1000) {
  const deadline = performance.now() + budget
  do { if (await predicate()) return true; await delay(10) } while (performance.now() < deadline)
  return false
}
try {
  assert.equal((await observer.query("SELECT 1 FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")).rowCount, 0,
    'operation checks require an empty disposable database')
  await observer.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'))
  control = await createLingxiOS({ database: pool, background: { role: 'passive' } })
  await control.conversations.sync(policy)
  const cases = [
    ['readRunState', 'agent_work_items', context => control.readRunState(identity, context)],
    ['readEvents', 'agent_work_items', context => control.readEvents(identity, 0, context)],
    ['readApproval', 'agent_approvals', context => control.readApproval({ tenantId: policy.tenantId, principalId: 'human', approvalId: 'missing' }, context)],
    ['readTerminal', 'agent_work_items', context => control.readTerminal(identity, context)],
    ['conversations.sync', 'agent_conversations', context => control.conversations.sync(policy, context)],
    ['conversations.ingest', 'agent_conversations', context => control.conversations.ingest(message, {}, context)],
  ]
  for (const [name, table, invoke] of cases) {
    const locker = await observer.connect()
    let pending, foreground, outcome, frontendReady = false, backendPid
    try {
      await locker.query('BEGIN')
      await locker.query(`LOCK TABLE lingxios.${table} IN ACCESS EXCLUSIVE MODE`)
      const controller = new AbortController()
      pending = invoke({ signal: controller.signal, deadlineAt: new Date(Date.now() + 2000).toISOString() })
        .then(() => { outcome = 'success' }, () => { outcome = 'rejected' })
      assert.ok(await until(async () => {
        backendPid = (await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'", [appName])).rows[0]?.pid
        return backendPid !== undefined
      }), `${name}: expected actual PostgreSQL lock wait`)
      foreground = pool.query('SELECT 1 AS ready').then(() => { frontendReady = true })
      const began = performance.now()
      controller.abort(new Error('synthetic callback cancelled'))
      const serverStopped = await until(async () => (await observer.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [backendPid])).rowCount === 0, 400)
      const elapsedMs = Math.round((performance.now() - began) * 100) / 100
      results.push({ name, outcome: outcome ?? 'pending', frontendReady, serverStopped, elapsedMs,
        passed: outcome === 'rejected' && frontendReady && serverStopped })
    } finally {
      await locker.query('ROLLBACK'); locker.release()
      await pending; await foreground
    }
  }
  // Reject pre-cancelled work before any acquisition, including writes.
  for (const [name, , invoke] of cases) {
    const controller = new AbortController(); controller.abort(new Error('pre-cancelled'))
    const before = acquisitions
    let rejected = false
    try { await invoke({ signal: controller.signal }) } catch { rejected = true }
    results.push({ name: `${name}:pre-aborted`, rejected, acquisitions: acquisitions - before,
      passed: rejected && acquisitions === before })
  }
  assert.ok(results.every(result => result.passed), 'public operations must reject cancellation and stop the actual PostgreSQL backend')
  const fresh = () => ({ deadlineAt: new Date(Date.now() + 1000).toISOString() })
  const settings = async () => (await pool.query("SELECT name,setting FROM pg_settings WHERE name IN ('statement_timeout','client_connection_check_interval') ORDER BY name")).rows
  const originalSettings = await settings()
  await control.readEvents(identity, 0, fresh())
  assert.deepEqual(await settings(), originalSettings)
  const shared = { deadlineAt: new Date(Date.now() + 40).toISOString() }
  await control.readTerminal(identity, shared)
  await delay(50)
  const beforeExpired = acquisitions
  await assert.rejects(control.readRunState(identity, shared), { name: 'TimeoutError' })
  assert.equal(acquisitions, beforeExpired)
  results.push({ name: 'session-reset-and-shared-absolute-deadline', passed: true })

  // Lock after the IM row and work row were inserted: abort must roll back both.
  await observer.query(`CREATE FUNCTION public.pause_operation_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(712349); RETURN NEW; END $$;
    CREATE TRIGGER operation_insert_pause AFTER INSERT ON lingxios.agent_work_items
    FOR EACH ROW EXECUTE FUNCTION public.pause_operation_insert()`)
  const blocker = await observer.connect()
  try {
    await blocker.query('SELECT pg_advisory_lock(712349)')
    const controller = new AbortController()
    const pending = control.conversations.ingest(message, {}, { signal: controller.signal, ...fresh() })
    const rejected = assert.rejects(pending, /rollback test/)
    assert.ok(await until(async () => (await observer.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event='advisory'", [appName])).rowCount === 1))
    controller.abort(new Error('rollback test'))
    await rejected
    assert.ok(await until(async () => (await observer.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1", [appName])).rowCount === 0))
    assert.equal((await observer.query('SELECT 1 FROM lingxios.agent_im_messages')).rowCount, 0)
    assert.equal((await observer.query('SELECT 1 FROM lingxios.agent_work_items')).rowCount, 0)
    results.push({ name: 'ingress-abort-rolls-back-inserted-message-and-work', passed: true })
  } finally {
    await blocker.query('SELECT pg_advisory_unlock(712349)'); blocker.release()
    await observer.query('DROP TRIGGER operation_insert_pause ON lingxios.agent_work_items; DROP FUNCTION public.pause_operation_insert()')
  }

  // The server deadline remains a bound when the application sends no abort.
  await observer.query(`CREATE FUNCTION public.sleep_operation_sync() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(3); RETURN NEW; END $$;
    CREATE TRIGGER operation_sync_pause BEFORE INSERT ON lingxios.agent_conversations
    FOR EACH ROW EXECUTE FUNCTION public.sleep_operation_sync()`)
  const deadlineStart = performance.now()
  try {
    await assert.rejects(control.conversations.sync({ ...policy, conversationId: 'deadline-only' },
      { deadlineAt: new Date(Date.now() + 120).toISOString() }))
    assert.ok(await until(async () => (await observer.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1", [appName])).rowCount === 0))
    assert.ok(performance.now() - deadlineStart < 1000)
    assert.equal((await observer.query("SELECT 1 FROM lingxios.agent_conversations WHERE id='deadline-only'")).rowCount, 0)
    results.push({ name: 'server-sleep-deadline', elapsedMs: Math.round(performance.now() - deadlineStart), passed: true })
  } finally {
    await observer.query('DROP TRIGGER operation_sync_pause ON lingxios.agent_conversations; DROP FUNCTION public.sleep_operation_sync()')
  }

  // Commit really reaches PostgreSQL, then hide its acknowledgement. The API
  // must reject; replay must find the durable receipt, never create another run.
  let committedResolve, hideCommit = false
  const committed = new Promise(resolve => { committedResolve = resolve })
  const ambiguousPool = { query: (...args) => pool.query(...args), async connect() {
    const client = await pool.connect()
    return { release: error => client.release(error), async query(sql, params) {
      const result = await client.query(sql, params)
      if (hideCommit && /^COMMIT$/i.test(sql)) { committedResolve(); return new Promise(() => {}) }
      return result
    } }
  } }
  const ambiguous = await createLingxiOS({ database: ambiguousPool, background: { role: 'passive' } })
  try {
    const controller = new AbortController(); hideCommit = true
    const pending = ambiguous.conversations.ingest(message, {}, { signal: controller.signal, ...fresh() })
    const rejected = assert.rejects(pending, /commit acknowledgement lost/)
    await committed; controller.abort(new Error('commit acknowledgement lost')); await rejected
    const replay = await control.conversations.ingest(message, {}, fresh())
    assert.equal(replay.deduplicated, true)
    assert.equal(replay.runs.length, 1)
    assert.equal((await observer.query('SELECT 1 FROM lingxios.agent_im_messages')).rowCount, 1)
    assert.equal((await observer.query('SELECT 1 FROM lingxios.agent_work_items')).rowCount, 1)
    const run = { ...identity, runId: replay.runs[0].runId, sessionId: replay.runs[0].sessionId }
    assert.ok(await control.readRunState(run, fresh()))
    await assert.rejects(control.readRunState({ ...run, principalId: 'outsider' }, fresh()))
    assert.equal(await control.readRunState({ ...run, tenantId: 'other-tenant' }, fresh()), null)
    await control.conversations.sync({ ...policy, version: 2, owner: { kind: 'organization', id: 'organization' },
      participants: policy.participants.filter(member => member.id !== 'human') }, fresh())
    await assert.rejects(control.conversations.ingest(message, {}, fresh()))
    await assert.rejects(control.readTerminal(run, fresh()))
    results.push({ name: 'unknown-commit-idempotent-replay-and-current-authorization', passed: true })
  } finally { await ambiguous.stop() }
  console.log(JSON.stringify({ node: process.version, postgres: (await observer.query('SHOW server_version')).rows[0].server_version,
    applicationPoolMax: 1, productionOperations: 0, providerCalls: 0, results }, null, 2))
} finally {
  await control?.stop()
  await pool.end(); await observer.end()
}
