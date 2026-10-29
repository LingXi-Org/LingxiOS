import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { it } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { PgModelBudgetStore, PgWorkStore, type SqlPool } from '../src/control-plane/pg-store.js'
import { admitChildBudget } from '../src/model/child-admission.js'
import { hashToken } from './memory-store-fixture.js'
import { toolExecutor } from '../src/tools/executor.js'
import { toolContractHash } from '../src/tools/contracts.js'
import type { ToolDefinition } from '../src/tools/definition.js'

async function fixture() {
  const db = new PGlite()
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  const pool: SqlPool = { query: async (sql, params) => {
    const result = await db.query<Record<string, unknown>>(sql, params)
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
  }, connect: async () => ({ query: pool.query, release() {} }) }
  const work = new PgWorkStore(pool), budgets = new PgModelBudgetStore(pool)
  const enqueue = async (id: string) => work.enqueue({ id, tenantId: 'tenant', agentId: 'agent', principalId: 'human',
    sessionId: id, kind: 'turn', lane: 'interactive', triggerRef: id,
    meta: { text: 'PRIVATE_REQUEST', ...(id === 'root' ? {} : { rootWorkId: 'root', rootRequestVersion: 1 }) } })
  await enqueue('root')
  const parent = (await work.claim('parent'))!
  const limits = { maxModelCalls: 10, maxTokens: 350, maxCostMicros: 100, deadlineAt: new Date(Date.now()+60000).toISOString(),
    reservedTokens: 20, reservedInputTokens: 10, reservedOutputTokens: 10, reservedCostMicros: 2,
    pricing: { version: 'fixture', currency: 'USD' as const, inputMicrosPerMillion: 100000, outputMicrosPerMillion: 100000 },
    childAdmission: { inputTokens: 90, outputTokens: 10, executionMs: 1000 } }
  const admit = async (id: string) => {
    await db.exec('BEGIN')
    try {
      const result = await admitChildBudget(pool,parent,1,id)
      if (result.allowed) await enqueue(id)
      await db.exec('COMMIT')
      return result
    } catch (error) { await db.exec('ROLLBACK'); throw error }
  }
  return { db, pool, work, budgets, parent, limits, admit }
}

it('reserves child startup and root closing capacity, consumes only the matching hold, and releases cancelled holds', async () => {
  const f = await fixture()
  try {
    await f.budgets.reserve('root','first',f.limits)
    assert.equal((await f.admit('one')).allowed,true)
    assert.equal((await f.admit('two')).allowed,true)
    const denied = await f.admit('three')
    assert.equal(denied.allowed,false); assert.equal(denied.dimension,'tokens')
    assert.equal((await f.db.query("SELECT 1 FROM lingxios.agent_work_items WHERE id='three'")).rows.length,0)
    assert.equal((await f.admit('three')).allowed,false)
    const feedback = (await f.db.query<Record<string, unknown>>('SELECT * FROM lingxios.agent_terminal_outbox')).rows
    assert.equal(feedback.length,1); assert.equal(feedback[0]!['reason'],'budget_limit')
    assert.equal(feedback[0]!['not_started_count'],1)
    assert.doesNotMatch(JSON.stringify(feedback),/PRIVATE_REQUEST/)
    const child = (await f.work.claim('child'))!
    const proof = { workId: child.id, fence: child.fence, leaseTokenHash: hashToken(child.leaseToken) }
    assert.equal((await f.budgets.reserve('root','child-first',f.limits,proof)).allowed,true)
    assert.equal((await f.db.query('SELECT 1 FROM lingxios.agent_model_budget_holds WHERE work_id=$1',[child.id])).rows.length,0)
    // A larger second call must protect the sibling and root closing reservations.
    const blocked = await f.budgets.reserve('root','child-large',{ ...f.limits,reservedTokens: 200 },proof)
    assert.equal(blocked.allowed,false); assert.equal(blocked.dimension,'reservation')
    await f.db.exec("UPDATE lingxios.agent_work_items SET status='cancelled' WHERE id='two'")
    assert.equal((await f.db.query("SELECT 1 FROM lingxios.agent_model_budget_holds WHERE work_id='two'")).rows.length,0)
    assert.equal((await f.admit('four')).allowed,true)
    assert.equal((await f.db.query('SELECT 1 FROM lingxios.agent_results')).rows.length,0)
  } finally { await f.db.close() }
})

it('reports missing profiles, cost, calls and deadline admission without creating work or resetting the root', async () => {
  for (const dimension of ['reservation','cost','calls','deadline'] as const) {
    const f = await fixture()
    try {
      if (dimension !== 'reservation') await f.budgets.reserve('root','first',{ ...f.limits,
        ...(dimension === 'cost' ? { maxCostMicros: 15 } : {}),
        ...(dimension === 'calls' ? { maxModelCalls: 2 } : {}),
        ...(dimension === 'deadline' ? { deadlineAt: new Date(Date.now()+1000).toISOString() } : {}) })
      const result = await f.admit('denied')
      assert.equal(result.allowed,false); assert.equal(result.dimension,dimension)
      assert.equal((await f.db.query('SELECT 1 FROM lingxios.agent_work_items')).rows.length,1)
    } finally { await f.db.close() }
  }
})

it('rolls back graph creation on admission failure and separately persists one authorized root notice', async () => {
  const f = await fixture()
  try {
    await f.budgets.reserve('root','first',{ ...f.limits,maxTokens: 250 })
    await f.db.query("INSERT INTO lingxios.agent_os_sessions(session_key,tenant_id,agent_id,session_id) VALUES('root','tenant','agent','root')")
    await f.db.query(`INSERT INTO lingxios.agent_request_snapshots(work_id,session_key,request_snapshot) VALUES('root','root',$1::jsonb)`,
      [JSON.stringify({ workId: 'root',revisions: [],attachments: [] })])
    const tool: ToolDefinition = { name: 'delegate__graph',action: 'delegate.graph',description: 'Fixture',effect: 'transaction',approval: false,
      parameters: { type: 'object',properties: {},additionalProperties: false },parse: () => ({}),authorize: async () => {},
      execute: async context => ({ ok: true,value: await context.enqueueGraph({ id: 'batch',nodes: [
        { id: 'one',agentId: 'agent',text: 'first' },{ id: 'two',agentId: 'agent',text: 'second' },
      ] }) }) }
    const action = { runId: 'root',cellId: 'graph',callIndex: 0,idempotencyKey: 'graph',action: tool.action,args: {} }
    await f.db.query('INSERT INTO lingxios.agent_action_intents(idempotency_key,fingerprint,intent) VALUES($1,$2,$3::jsonb)',
      [action.idempotencyKey,'fixture',JSON.stringify({ workId: 'root',requestVersion: 1,action,toolContractHash: toolContractHash(tool) })])
    const executor = toolExecutor(f.pool,[tool])
    for (let attempt=0; attempt<2; attempt++) await assert.rejects(executor.execute(f.parent,action,
      { requestVersion: 1,signal: AbortSignal.timeout(10000),deadlineAt: new Date(Date.now()+10000).toISOString() }),
    (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'budget_limit')
    assert.equal((await f.db.query('SELECT 1 FROM lingxios.agent_graphs')).rows.length,0)
    assert.equal((await f.db.query('SELECT 1 FROM lingxios.agent_work_items')).rows.length,1)
    assert.equal((await f.db.query('SELECT 1 FROM lingxios.agent_model_budget_holds')).rows.length,0)
    const feedback = (await f.db.query<Record<string, unknown>>('SELECT * FROM lingxios.agent_terminal_outbox')).rows
    assert.equal(feedback.length,1); assert.equal(feedback[0]!['not_started_count'],2)
  } finally { await f.db.close() }
})

it('admits a five-specialist team with sufficient budget while bounding pending fanout at eight', async () => {
  const f = await fixture()
  try {
    await f.budgets.reserve('root','first',{ ...f.limits,maxModelCalls: 50,maxTokens: 5000,maxCostMicros: 1000 })
    for (let index = 0; index < 8; index++) assert.equal((await f.admit(`specialist-${index}`)).allowed,true)
    assert.deepEqual(await f.admit('overflow'),{ allowed: false,dimension: 'reservation' })
    assert.equal((await f.db.query('SELECT 1 FROM lingxios.agent_model_budget_holds')).rows.length,9,'eight starts plus one closing hold')
    assert.equal((await f.db.query<{ not_started_count: number }>('SELECT not_started_count FROM lingxios.agent_terminal_outbox')).rows[0]?.not_started_count,1)
    await f.db.exec("UPDATE lingxios.agent_work_items SET status='cancelled' WHERE id='specialist-0'")
    assert.equal((await f.admit('replacement')).allowed,true)
  } finally { await f.db.close() }
})

// Exercise settled usage, not just a reservation ceiling. Failed/replayed costs
// must not disappear or double-charge, and denial must not allocate a child.
it('uses settled near-limit cost exactly once before child startup plus closing admission', async () => {
  const f = await fixture()
  try {
    const limits = { ...f.limits, maxCostMicros: 25 }
    await f.budgets.reserve('root', 'charged-call', limits)
    await f.budgets.record('root', 'charged-call', 90, 10, 10)
    await f.budgets.record('root', 'charged-call', 90, 10, 10)
    const before = (await f.db.query<{ cost_micros: number }>('SELECT cost_micros FROM lingxios.agent_model_budgets WHERE root_work_id=$1', ['root'])).rows[0]!
    assert.equal(Number(before.cost_micros), 10)
    const rejected = await f.admit('near-cost-limit')
    assert.equal(rejected.allowed, false); assert.equal(rejected.dimension, 'cost')
    assert.equal((await f.db.query("SELECT 1 FROM lingxios.agent_work_items WHERE id='near-cost-limit'")).rows.length, 0)
    assert.equal((await f.db.query('SELECT 1 FROM lingxios.agent_model_budget_holds')).rows.length, 0)
    assert.equal(Number((await f.db.query<{ cost_micros: number }>('SELECT cost_micros FROM lingxios.agent_model_budgets')).rows[0]!.cost_micros), 10)
    assert.equal((await f.db.query('SELECT 1 FROM lingxios.agent_terminal_outbox')).rows.length, 1)
  } finally { await f.db.close() }
})
