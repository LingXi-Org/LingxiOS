import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS, skillIndex, type SkillDeliveryDecision } from '../src/index.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import type { ToolDefinition } from '../src/tools/definition.js'
import { actionKeyOf, sessionKeyOf, type WorkItem } from '../src/protocol/types.js'
import { createResponseEnvelope } from '../src/outcome/envelope.js'
import { snapshotRequest } from '../src/context/request.js'
import { inspectSkillDeliveries, readSkillActivations, commitSkillDeliveries } from '../src/skills/delivery.js'

const skill = { name: 'diagram', version: 'v1', description: 'Author diagrams', body: 'Explicit authoring, no ordinary examples.', actions: ['documents.get'], delivery: { checker: 'product:diagram' } }
const native: ToolDefinition = { name: 'documents__get', action: 'documents.get', description: 'Read', parameters: { type: 'object', properties: {}, additionalProperties: false }, effect: 'read', approval: false,
  parse: value => value as Record<string, unknown>, authorize: async () => {}, execute: async () => ({ ok: true, value: {} }) }
const candidate = { body: 'A real checked diagram reference', requestVersion: 1, artifacts: [] }
const selection = (() => { const { name, version, hash } = skillIndex(skill); return { name, version, hash } })()
const action = (work: WorkItem, cellId: string, name: string, args: Record<string, unknown>) => {
  const identity = { runId: work.id, cellId, callIndex: 0 }; return { ...identity, idempotencyKey: actionKeyOf(identity), action: name, args }
}
async function fixture() {
  const db = new PGlite()
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  const pool: SqlPool = { query: async (sql, params) => { const result = await db.query<Record<string, unknown>>(sql, params); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length } }, connect: async () => ({ query: pool.query, release() {} }) }
  let grants = true, outcome: SkillDeliveryDecision['outcome'] = 'pending'
  const seen: unknown[] = []
  const app = await createLingxiOS({ database: pool, tools: [native], skills: [skill], capabilityResolver: { resolve: async () => grants ? [{ name: 'documents' }] : [] },
    verifyRun: async context => { seen.push(context.skillActivations); return [] },
    verifySkillDelivery: async context => context.skillActivations.map(activation => ({ activationId: activation.id, outcome, evidence: { checked: true } })) })
  const host = app.connectWorker({ workerId: 'skill-test', workKinds: ['turn'] })
  async function start(id: string) {
    await app.enqueue({ id, tenantId: 't', agentId: 'a', principalId: id, sessionId: id, text: 'Create a diagram.', deliveryMode: 'text' })
    const work = (await host.claimWork())!
    await host.saveSession(work, { key: sessionKeyOf(work), tenantId: 't', agentId: 'a', sessionId: id, history: [], appliedWorkIds: [id], revision: 0, compactionEpoch: 0, request: snapshotRequest(await host.loadContext(work)) })
    return work
  }
  return { db, pool, app, host, start, seen, revoke: () => { grants = false }, outcome: (value: SkillDeliveryDecision['outcome']) => { outcome = value }, close: async () => { await app.stop(); await db.close() } }
}
it('loads are reference-only; authoring activation is durable, exact, deduplicated and publicly visible', async () => {
  const f = await fixture()
  try {
    const work = await f.start('owner')
    assert.equal((await f.host.executeAction(work, action(work, 'load', 'skills.load', selection))).ok, true)
    assert.deepEqual(await readSkillActivations(f.pool, work, 1), [])
    assert.equal((await f.host.executeAction(work, action(work, 'forged', 'skills.activate', { ...selection, outcome: 'delivered' }))).ok, false)
    assert.equal((await f.host.executeAction(work, action(work, 'stale', 'skills.activate', { ...selection, hash: '0'.repeat(64) }))).ok, false)
    for (const cell of ['author', 'again']) { const result = await f.host.executeAction(work, action(work, cell, 'skills.activate', selection)); assert.equal(result.ok, true, JSON.stringify(result)) }
    const active = await readSkillActivations(f.pool, work, 1)
    assert.equal(active.length, 1); assert.equal(active[0]!.tenantId, 't'); assert.equal(active[0]!.runId, work.id); assert.equal(active[0]!.requestVersion, 1)
    assert.deepEqual(active[0]!.skill, selection); assert.equal(active[0]!.checker, 'product:diagram')
    assert.deepEqual(await readSkillActivations(f.pool, { ...work, tenantId: 'foreign' }, 1), [])
    const checks = (await f.host.verifyCandidate!(work, candidate)).records
    assert.equal(checks.find(c => c.checker.startsWith('skill-delivery:'))!.status, 'inconclusive')
    assert.deepEqual(f.seen.at(-1), active)
    f.outcome('delivered')
    assert.equal((await f.host.verifyCandidate!(work, candidate)).records.find(c => c.checker.startsWith('skill-delivery:'))!.status, 'passed')
    assert.equal((await f.db.query<Record<string, unknown>>('SELECT resolution FROM lingxios.agent_skill_activations')).rows[0]!['resolution'], null, 'candidate verification cannot resolve delivery')
    const inspection = await f.host.executeAction(work, action(work, 'inspect', 'task.inspect', {}))
    assert.equal((inspection.value as { completedBusinessAction: boolean }).completedBusinessAction, false)
    f.revoke()
    assert.equal((await f.host.verifyCandidate!(work, candidate)).records.find(c => c.checker.startsWith('skill-delivery:'))!.status, 'inconclusive')
    f.outcome('unsupported')
    assert.equal((await f.host.verifyCandidate!(work, candidate)).records.find(c => c.checker.startsWith('skill-delivery:'))!.status, 'passed')
  } finally { await f.close() }
})
it('activation rejects cancellation and stale request versions; decisions cannot cross identity or resolve by omission', async () => {
  const f = await fixture()
  try {
    const work = await f.start('current')
    assert.equal((await f.host.executeAction(work, action(work, 'author', 'skills.activate', selection))).ok, true)
    const active = await readSkillActivations(f.pool, work, 1)
    assert.equal(inspectSkillDeliveries(active, [])[0]!.status, 'inconclusive')
    assert.throws(() => inspectSkillDeliveries(active, [{ activationId: 'foreign', outcome: 'delivered', evidence: {} }]))
    assert.throws(() => inspectSkillDeliveries(active, [0, 1].map(() => ({ activationId: active[0]!.id, outcome: 'delivered', evidence: {} }))))
    for (const outcome of ['unsupported', 'failed'] as const) assert.equal(inspectSkillDeliveries(active, [{ activationId: active[0]!.id, outcome, evidence: { explained: true } }])[0]!.evidence['outcome'], outcome)
    await f.db.query("UPDATE lingxios.agent_work_items SET steer_inputs='[{\"text\":\"new request\",\"author\":{\"kind\":\"user\",\"id\":\"current\"}}]'::jsonb WHERE id=$1", [work.id])
    assert.deepEqual(await readSkillActivations(f.pool, work, 2), [])
    await assert.rejects(f.host.verifyCandidate!(work, candidate), /request/)
    const cancelled = await f.start('cancelled')
    await f.db.query<Record<string, unknown>>('UPDATE lingxios.agent_work_items SET cancel_requested_at=NOW() WHERE id=$1', [cancelled.id])
    await assert.rejects(f.host.executeAction(cancelled, action(cancelled, 'author', 'skills.activate', selection)))
    assert.equal((await f.db.query<Record<string, unknown>>('SELECT count(*)::int AS n FROM lingxios.agent_skill_activations WHERE work_id=$1', [cancelled.id])).rows[0]!['n'], 0)
  } finally { await f.close() }
})
it('resolution commit is bound to its candidate and rejects pending or superseded evidence', async () => {
  const f = await fixture()
  try {
    const work = await f.start('commit')
    await f.host.executeAction(work, action(work, 'author', 'skills.activate', selection))
    const active = await readSkillActivations(f.pool, work, 1)
    await assert.rejects(commitSkillDeliveries(f.pool, work, candidate, inspectSkillDeliveries(active, [])))
    const checks = inspectSkillDeliveries(active, [{ activationId: active[0]!.id, outcome: 'unsupported', evidence: { explained: true } }])
    await f.db.query<Record<string, unknown>>('BEGIN')
    await commitSkillDeliveries(f.pool, work, candidate, checks)
    await f.db.query<Record<string, unknown>>('ROLLBACK')
    assert.equal((await f.db.query<Record<string, unknown>>('SELECT resolution FROM lingxios.agent_skill_activations')).rows[0]!['resolution'], null)
    await commitSkillDeliveries(f.pool, work, candidate, checks)
    assert.equal((await f.db.query<Record<string, unknown>>('SELECT resolution FROM lingxios.agent_skill_activations')).rows[0]!['resolution'], 'unsupported')
    await assert.rejects(commitSkillDeliveries(f.pool, work, { ...candidate, requestVersion: 2 }, checks))
  } finally { await f.close() }
})
it('final commit rechecks delivery and cannot hide pending authoring in a partial response', async () => {
  const f = await fixture()
  try {
    const work = await f.start('final')
    await f.host.executeAction(work, action(work, 'author', 'skills.activate', selection))
    f.outcome('delivered')
    await f.host.verifyCandidate!(work, candidate)
    f.outcome('pending')
    const request = (await f.host.loadSession(work, sessionKeyOf(work)))!.request!
    const body = 'This delivery is unavailable; no diagram was delivered.'
    const envelope = createResponseEnvelope(body, { status: 'partial', verification: 'not_run', requestVersion: 1 }, request.evidence)
    const message = { version: 2 as const, runId: work.id, agentId: work.agentId, sessionId: work.sessionId, body, envelope }
    await assert.rejects(f.host.commitResult(work, message), /skill delivery/)
    assert.equal((await f.db.query<Record<string, unknown>>('SELECT count(*)::int AS n FROM lingxios.agent_results')).rows[0]!['n'], 0)
    f.outcome('unsupported')
    await f.host.commitResult(work, message)
    const row = (await f.db.query<Record<string, unknown>>('SELECT resolution,resolved_candidate_hash FROM lingxios.agent_skill_activations')).rows[0]!
    assert.equal(row['resolution'], 'unsupported'); assert.match(String(row['resolved_candidate_hash']), /^[a-f0-9]{64}$/)
  } finally { await f.close() }
})
it('a durable input wait preserves a pending authoring obligation without pretending delivery', async () => {
  const f = await fixture()
  try {
    const work = await f.start('waiting')
    await f.host.executeAction(work, action(work, 'author', 'skills.activate', selection))
    const question = 'Which data should the diagram use?'
    const asked = await f.host.executeAction(work, action(work, 'ask', 'task.ask', { question }))
    assert.equal(asked.ok, true)
    const request = (await f.host.loadSession(work, sessionKeyOf(work)))!.request!
    const envelope = createResponseEnvelope(question, { status: 'awaiting_input', question, verification: 'not_run', requestVersion: 1 }, request.evidence)
    await f.host.commitResult(work, { version: 2, runId: work.id, agentId: work.agentId, sessionId: work.sessionId, body: question, envelope })
    assert.equal((await f.db.query<Record<string, unknown>>('SELECT resolution FROM lingxios.agent_skill_activations')).rows[0]!['resolution'], null)
  } finally { await f.close() }
})
it('schema13 upgrades explicitly to14 and remains incompatible with older rollback', async () => {
  const db = new PGlite()
  try {
    await db.exec(await readFile(new URL('../../db/schema-013.sql', import.meta.url), 'utf8'))
    const migration = await readFile(new URL('../../db/migrations/016-skill-delivery.sql', import.meta.url), 'utf8')
    await db.exec('DELETE FROM lingxios.schema_version')
    await assert.rejects(db.exec(migration), /requires schema 13/)
    await db.exec('ROLLBACK; INSERT INTO lingxios.schema_version(singleton,version) VALUES(TRUE,13)')
    await db.exec(migration)
    assert.equal((await db.query<Record<string, unknown>>('SELECT version FROM lingxios.schema_version')).rows[0]!['version'], 14)
    await assert.rejects(db.exec(await readFile(new URL('../../db/migrations/015-memory-continuity-rollback.sql', import.meta.url), 'utf8')), /requires schema 12 or 13/)
  } finally { await db.close() }
})
