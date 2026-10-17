import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { it } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { PgStepStore } from '../src/control-plane/steps.js'
import { PgActionLedger, PgEventStore, PgModelBudgetStore, PgSessionStore, PgWorkStore, type SqlPool } from '../src/control-plane/pg-store.js'
import { ControlPlaneService } from '../src/control-plane/service.js'
import { actionKeyOf } from '../src/protocol/types.js'
import { type ToolDefinition } from '../src/tools/definition.js'
import { toolExecutor } from '../src/tools/executor.js'

it('rolls back the first mutation and commits exactly one effect and receipt under the original action identity', async () => {
  const db = new PGlite()
  const pool: SqlPool = {
    async query(sql, params) {
      const result = await db.query<Record<string, unknown>>(sql, params)
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
    }, connect: async () => ({ query: pool.query, release() {} }),
  }
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  await db.exec('CREATE TABLE recovery_effects(id text PRIMARY KEY, count integer NOT NULL)')
  let executions = 0, authorizations = 0
  const tool: ToolDefinition = { name: 'documents__create', action: 'documents.create', description: 'Create', effect: 'transaction', approval: false,
    parameters: { type: 'object', properties: {}, additionalProperties: false }, parse: () => ({}),
    async authorize() { authorizations++ },
    async execute(ctx) {
      executions++
      await ctx.database.query('INSERT INTO recovery_effects VALUES($1,1) ON CONFLICT(id) DO UPDATE SET count=recovery_effects.count+1', [ctx.action.idempotencyKey])
      if (executions === 1) throw Object.assign(new Error('private dependency detail'), { code: '40001' })
      return { ok: true, executionState: 'succeeded', value: { created: true } }
    },
  }
  const actions = new PgActionLedger(pool)
  const service = new ControlPlaneService({ steps: new PgStepStore(pool), modelBudgets: new PgModelBudgetStore(pool),
    tools: [tool], work: new PgWorkStore(pool), actions, events: new PgEventStore(pool), sessions: new PgSessionStore(pool),
    actionExecutor: toolExecutor(pool, [tool]), capabilityResolver: { resolve: async () => [{ name: 'documents' }] },
    contextProvider: { loadContext: async () => ({ persona: { name: '', role: '', instructions: '' }, capabilities: [], messages: [] }) },
    delivery: { onEvent: async () => {}, deliverMessage: async () => {} } })
  try {
    await service.enqueue({ id: 'recovery-work', tenantId: 'tenant', agentId: 'agent', sessionId: 'session', principalId: 'principal',
      kind: 'turn', lane: 'interactive', triggerRef: 'message' })
    const work = (await service.claim('worker'))!
    const identity = { runId: work.id, cellId: 'cell', callIndex: 0 }
    const action = { ...identity, action: tool.action, args: {}, idempotencyKey: actionKeyOf(identity) }
    const result = await service.executeAction(work, action)
    assert.equal(result.ok, true)
    assert.deepEqual((await db.query('SELECT * FROM recovery_effects')).rows, [{ id: action.idempotencyKey, count: 1 }])
    assert.deepEqual(await actions.find(action.idempotencyKey), result)
    assert.equal(executions, 2)
    assert.equal(authorizations, 3, 'preflight and both transactional attempts reauthorize')
    assert.deepEqual(await service.executeAction(work, action), result)
    assert.equal(executions, 2, 'durable replay never repeats either transaction attempt')
    assert.deepEqual(await actions.unsettled(work.id), [])
  } finally { await db.close() }
})
