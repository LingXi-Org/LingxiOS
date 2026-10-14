import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { it } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { snapshotRequest } from '../src/context/request.js'
import { ControlPlaneServer, ControlPlaneService } from '../src/control-plane/http-server.js'
import { MemoryActionLedger, MemoryEventStore, MemoryModelBudgetStore, MemorySessionStore, MemoryWorkStore } from '../src/control-plane/memory-store.js'
import { PgSessionStore, PgWorkStore, type SqlPool } from '../src/control-plane/pg-store.js'
import { MemoryStepStore } from '../src/control-plane/steps.js'
import { HttpHostClient } from '../src/host/http-client.js'
import { sessionKeyOf, type SessionRecord } from '../src/protocol/types.js'

for (const backend of ['memory', 'postgres'] as const) it(`${backend}: revoked evidence cannot poison the next turn or prevent terminal failure over HTTP`, async () => {
  const db = new PGlite()
  const pool: SqlPool = { query: async (sql, params) => {
    const result = await db.query<Record<string, unknown>>(sql, params)
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
  }, connect: async () => ({ query: pool.query, release() {} }) }
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  const workStore = backend === 'postgres' ? new PgWorkStore(pool) : new MemoryWorkStore()
  const sessions = backend === 'postgres' ? new PgSessionStore(pool) : new MemorySessionStore()
  let revoked = false, workDenied = false, unexpectedFailure = false
  const evidence = { marker: 'S1', sourceId: 'deleted-source', sourceVersion: 'v1', chunkId: 'chunk', title: 'Private source', excerpt: 'revoked-secret' }
  const service = new ControlPlaneService({ work: workStore, sessions, steps: new MemoryStepStore(),
    modelBudgets: new MemoryModelBudgetStore(), events: new MemoryEventStore(), actions: new MemoryActionLedger(),
    ...(sessions instanceof PgSessionStore ? { contextSnapshot: work => sessions.context(work) } : {}),
    authorizeWork: async () => { if (workDenied) throw new Error('work authorization revoked') },
    contextProvider: {
      authorizeRequest: async (_work, request) => {
        if (unexpectedFailure) throw new Error('authorization database unavailable')
        if (revoked && request.evidence.items.length) throw new Error('source permission revoked')
      },
      loadContext: async work => ({ persona: { name: 'A', role: '', instructions: '' }, capabilities: [],
        messages: [{ ref: work.triggerRef, authorId: 'u', authorName: 'U', authorKind: 'human', body: String(work.meta?.['text']), createdAt: 'now' }],
        evidence: revoked ? [] : [evidence] }),
    },
    capabilityResolver: { resolve: async () => [] },
    actionExecutor: { prepare: async () => {}, execute: async () => { throw new Error('unexpected effect') } },
    delivery: { onEvent: async () => {}, deliverMessage: async () => { throw new Error('unexpected delivery') } },
  })
  const server = new ControlPlaneServer({ service, claimWork: id => service.claim(id), serviceToken: 'test-secret' })
  const port = await server.listen(0, '127.0.0.1')
  const client = new HttpHostClient({ baseUrl: `http://127.0.0.1:${port}`, serviceToken: 'test-secret', workerId: 'worker', maxAttempts: 1 })
  const enqueue = (id: string) => service.enqueue({ id, tenantId: 't', agentId: 'a', sessionId: 's', principalId: 'u',
    kind: 'turn', lane: 'interactive', triggerRef: id, meta: { text: id } })
  const failed = { status: 'failed' as const, error: 'source unavailable',
    goalOutcome: { status: 'blocked' as const, verification: 'inconclusive' as const, requestVersion: 1 } }
  try {
    await enqueue('old')
    const old = (await client.claimWork())!, key = sessionKeyOf(old)
    const session: SessionRecord = { key, tenantId: 't', agentId: 'a', sessionId: 's', revision: 0, compactionEpoch: 0,
      history: [{ role: 'assistant', content: 'revoked-secret' }], summary: 'revoked-secret', appliedWorkIds: [old.id],
      promptContext: { version: 3, epoch: 0, assembledAt: '', systemInstructions: 'revoked-secret',
        persona: { name: 'A', role: '', instructions: '' }, capabilities: [], sourceVersions: {} },
      request: snapshotRequest(await client.loadContext(old)) }
    await client.saveSession(old, session)
    await client.completeWork(old, { status: 'completed', goalOutcome: { status: 'partial', verification: 'not_run', requestVersion: 1 } })
    await enqueue('next')
    const next = (await client.claimWork())!
    assert.deepEqual(await client.loadSession(next, key), session, 'authorized history must survive a new turn')
    revoked = true
    workDenied = true
    await assert.rejects(client.loadSession(next, key))
    workDenied = false
    const cleared = await client.loadSession(next, key)
    assert.deepEqual(cleared, { key, tenantId: 't', agentId: 'a', sessionId: 's', revision: session.revision,
      compactionEpoch: 1, history: [], appliedWorkIds: [] })
    const context = await client.loadInitialContext(next)
    assert.deepEqual(context.session, cleared)
    assert.equal(JSON.stringify(context).includes('revoked-secret'), false)
    assert.equal(context.snapshotVersion?.requestVersion, 1)
    const fresh = { ...cleared!, request: snapshotRequest(context), appliedWorkIds: [next.id] }
    await client.saveSession(next, fresh)
    assert.deepEqual(await client.loadSession(next, key), fresh, 'fresh request must save with the original revision')
    await client.completeWork(next, { status: 'completed', goalOutcome: { status: 'partial', verification: 'not_run', requestVersion: 1 } })

    revoked = false
    await enqueue('current')
    const current = (await client.claimWork())!
    const currentContext = await client.loadInitialContext(current)
    const currentSession = { ...currentContext.session!, request: snapshotRequest(currentContext) }
    await client.saveSession(current, currentSession)
    revoked = true
    await assert.rejects(client.loadSession(current, key))
    await assert.rejects(client.loadInitialContext(current))
    await assert.rejects(client.completeWork(current, { status: 'completed', goalOutcome: { status: 'partial', verification: 'not_run', requestVersion: 1 } }))
    await assert.rejects(client.completeWork(current, { ...failed, goalOutcome: { status: 'satisfied', verification: 'inconclusive', requestVersion: 1 } }))
    await assert.rejects(client.completeWork({ ...current, fence: current.fence + 1 }, failed))
    unexpectedFailure = true
    await client.completeWork(current, failed)
    assert.equal(await client.claimWork(), null, 'failed work must never be reclaimed')
    if (backend === 'postgres') {
      const row = (await db.query<{ status: string; error: string; goal_outcome: unknown }>('SELECT status,error,goal_outcome FROM lingxios.agent_work_items WHERE id=$1', [current.id])).rows[0]
      assert.deepEqual(row, { status: 'failed', error: failed.error, goal_outcome: failed.goalOutcome })
      assert.equal((await db.query('SELECT work_id FROM lingxios.agent_os_session_leases')).rows.length, 0)
    }
  } finally { await server.close(); await db.close() }
})
