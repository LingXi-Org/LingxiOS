import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS, skillIndex, type ActionContext, type ToolDefinition } from '../src/index.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import { actionKeyOf, sessionKeyOf, type WorkItem } from '../src/protocol/types.js'
import { snapshotRequest } from '../src/context/request.js'
import { readSkillActivations } from '../src/skills/delivery.js'

const skill = { name: 'diagram', version: 'v1', description: 'Author', body: 'Author', actions: ['documents.save'], delivery: { checker: 'product:diagram' } }
const { name, version, hash } = skillIndex(skill), selection = { name, version, hash }
// This cast lets the pre-implementation run fail at the actual missing public method.
const activate = (context: ActionContext, selected = selection) => (context as ActionContext & {
  activateSkillDelivery(selection: typeof selected): Promise<unknown>
}).activateSkillDelivery(selected)
async function fixture() {
  const db = new PGlite(); await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  await db.exec('CREATE TABLE product_documents(id text PRIMARY KEY)')
  let tail = Promise.resolve(), transaction = false, leakedTransactions = 0
  const acquire = async () => { let done!: () => void; const prior = tail; tail = new Promise<void>(resolve => { done = resolve }); await prior; return done }
  const query: SqlPool['query'] = async (sql, params) => {
    const result = await db.query<Record<string, unknown>>(sql, params)
    if (/^BEGIN/.test(sql)) transaction = true
    if (/^(COMMIT|ROLLBACK)/.test(sql)) transaction = false
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
  }
  const pool: SqlPool = { query: async (sql, params) => { const release = await acquire(); try { return await query(sql, params) } finally { release() } }, connect: async () => {
    const release = await acquire(); let released = false
    return { query, release(error) {
      if (released) return; released = true
      void (async () => { try {
        if (transaction) { if (!error) leakedTransactions++; await query('ROLLBACK') }
      } finally { release() } })()
    } }
  } }
  let mode = 'save', denied = false, staged = false
  const controller = new AbortController()
  const tool: ToolDefinition = { name: 'documents__save', action: 'documents.save', description: 'Author', parameters: { type: 'object', properties: {}, additionalProperties: false }, effect: 'transaction', approval: false,
    parse: value => value as Record<string, unknown>, authorize: async context => { if (mode === 'authorize') await activate(context) },
    execute: async context => {
      await activate(context, mode === 'wrong-hash' ? { ...selection, hash: '0'.repeat(64) } : selection)
      await context.database.query('INSERT INTO product_documents(id) VALUES($1)', [context.work.id]); staged = true
      if (mode === 'invalid') return { ok: false, executionState: 'no_effect', code: 'invalid_arguments', error: 'Unsupported input' }
      if (mode === 'throw') throw new Error('Authoring failed')
      if (mode === 'cancel') controller.abort()
      return { ok: true, value: { saved: true } }
    } }
  const read: ToolDefinition = { ...tool, name: 'documents__read', action: 'documents.read', effect: 'read', authorize: async () => {}, execute: async context => { await activate(context); return { ok: true, value: {} } } }
  const app = await createLingxiOS({ database: pool, background: { role: 'passive' }, performance: { notifications: false }, tools: [tool, read, { ...tool, name: 'documents__author', action: 'documents.author' }], skills: [skill], capabilityResolver: { resolve: async () => [{ name: 'documents', methods: denied ? ['read', 'author'] : ['save', 'read', 'author'] }] } })
  const host = app.connectWorker({ workerId: 'host-activation', workKinds: ['turn'] })
  const start = async (id: string) => {
    await app.enqueue({ id, tenantId: 'tenant', principalId: 'principal', agentId: 'agent', sessionId: id, text: 'Author a diagram' })
    const work = (await host.claimWork())!
    await host.saveSession(work, { key: sessionKeyOf(work), tenantId: work.tenantId, agentId: work.agentId, sessionId: id, history: [], appliedWorkIds: [id], revision: 0, compactionEpoch: 0, request: snapshotRequest(await host.loadContext(work)) })
    return work
  }
  const call = (work: WorkItem, method = 'documents.save', cellId = 'author') => {
    const identity = { runId: work.id, cellId, callIndex: 0 }
    return host.executeAction(work, { ...identity, idempotencyKey: actionKeyOf(identity), action: method, args: method === 'skills.activate' ? selection : {} }, controller.signal)
  }
  return { pool, start, call, staged: () => staged, mode: (value: string) => { mode = value }, revoke: () => { denied = true }, close: async () => { await app.stop(); await tail; await db.close(); assert.equal(leakedTransactions, 0) } }
}
it('a trusted authoring tool activates without a model activation call and deduplicates the exact native obligation', async () => {
  const f = await fixture()
  try {
    const work = await f.start('saved')
    assert.equal((await f.call(work)).ok, true)
    const active = await readSkillActivations(f.pool, work, 1)
    assert.equal(active.length, 1); assert.equal(active[0]!.tenantId, work.tenantId); assert.equal(active[0]!.runId, work.id); assert.deepEqual(active[0]!.skill, selection)
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM product_documents')).rows[0]!['count'], 1)
    assert.equal((await f.call(work, 'skills.activate', 'explicit-after')).ok, true)
    assert.equal((await readSkillActivations(f.pool, work, 1)).length, 1)
  } finally { await f.close() }
})
it('invalid/no-effect, thrown error and cancellation roll back both new activation and product writes', async () => {
  for (const mode of ['invalid', 'throw', 'cancel']) {
    const f = await fixture()
    try {
      const work = await f.start(mode); f.mode(mode)
      const result = await f.call(work).catch(() => null)
      assert.notEqual(result?.ok, true)
      assert.equal(f.staged(), true, 'the failure occurs after activation and the product write')
      assert.deepEqual(await readSkillActivations(f.pool, work, 1), [])
      assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM product_documents')).rows[0]!['count'], 0)
    } finally { await f.close() }
  }
})
it('read and authorization phases cannot activate; wrong contracts and revoked required capabilities fail closed', async () => {
  for (const mode of ['read', 'authorize', 'wrong-hash', 'revoked']) {
    const f = await fixture()
    try {
      const work = await f.start(mode); f.mode(mode); if (mode === 'revoked') f.revoke()
      const result = await f.call(work, mode === 'read' ? 'documents.read' : mode === 'revoked' ? 'documents.author' : 'documents.save').catch(() => null)
      assert.notEqual(result?.ok, true)
      assert.deepEqual(await readSkillActivations(f.pool, work, 1), [])
      assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM product_documents')).rows[0]!['count'], 0)
    } finally { await f.close() }
  }
})
it('a failed authoring transaction preserves an already committed explicit activation', async () => {
  const f = await fixture()
  try {
    const work = await f.start('prior')
    assert.equal((await f.call(work, 'skills.activate', 'explicit-before')).ok, true)
    f.mode('invalid'); assert.equal((await f.call(work)).ok, false)
    assert.equal((await readSkillActivations(f.pool, work, 1)).length, 1)
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM product_documents')).rows[0]!['count'], 0)
  } finally { await f.close() }
})

// Public port additions must not break existing non-opt-in context implementations.
const acceptLegacyContext = (context: Omit<ActionContext, 'activateSkillDelivery'>): ActionContext => context
void acceptLegacyContext
