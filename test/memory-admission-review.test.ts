import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createHash } from 'node:crypto'
import { memoryFixture, scope } from './memory-fixture.js'
import { createMemoryRuntime } from '../src/memory/runtime.js'
import { PgModelBudgetStore, type SqlPool } from '../src/control-plane/pg-store.js'
import { executionModel, DEFAULT_MODEL_BUDGET } from '../src/model/execution.js'
import { ModelBudgetExceededError, ModelDriverError } from '../src/errors.js'
import type { HostPort } from '../src/host/port.js'

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function setup() {
  const f = await memoryFixture({ contextBudget: { optionalRecall: true }, resolveScopes: async () => [{ ...scope, continuity: 'principal' }] })
  const { work } = await f.source({ leased: true, capture: false }), memory = createMemoryRuntime(f.pool, f.options)
  await memory.context(work)
  const proof = { workId: work.id, fence: work.fence, leaseTokenHash: createHash('sha256').update(work.leaseToken).digest('hex') }
  const limits = { maxModelCalls: 5, maxTokens: 1000, maxCostMicros: 1000, reservedTokens: 10, reservedCostMicros: 10, deadlineAt: new Date(Date.now() + 5000).toISOString() }
  return { f, work, memory, proof, limits }
}

it('checks the actual budget clock after final authorization awaits', async () => {
  const { f, work, memory, proof, limits } = await setup()
  const budgets = new PgModelBudgetStore(f.pool, async (db, w, ...args) => { await memory.admit(db, w, ...args); await pause(180) })
  try {
    limits.deadlineAt = new Date(Date.now() + 100).toISOString()
    await budgets.reserve(work.id, 'call', limits, proof)
    const result = await budgets.reserve(work.id, 'call', { ...limits, memoryAdmission: true }, proof)
    assert.ok(Date.now() > Date.parse(result.deadlineAt), 'fixture must cross the stored deadline')
    assert.equal(result.allowed, false)
    assert.equal(result.dimension, 'deadline')
  } finally { await f.close() }
})

it('binds context and the existing call to the original request revision', async () => {
  const { f, work, memory, proof, limits } = await setup(), budgets = new PgModelBudgetStore(f.pool, memory.admit)
  try {
    await budgets.reserve(work.id, 'old-call', limits, proof)
    assert.equal(await f.store.addSteer(work.id, 'Synthetic new request revision'), true)
    await assert.rejects(budgets.reserve(work.id, 'old-call', { ...limits, memoryAdmission: true }, proof), /request|revision|context/i)
    await memory.context(work)
    await assert.rejects(budgets.reserve(work.id, 'stale-new-call', { ...limits, memoryRequestVersion: 1 }, proof), /request|revision|context/i)
    await assert.rejects(budgets.reserve(work.id, 'old-call', { ...limits, memoryAdmission: true }, proof), /request|revision|context/i)
    await budgets.reserve(work.id, 'new-call', limits, proof)
    assert.equal((await budgets.reserve(work.id, 'new-call', { ...limits, memoryAdmission: true }, proof)).allowed, true)
    assert.equal((await f.db.query<{ calls: number }>('SELECT model_calls::int AS calls FROM lingxios.agent_model_budgets')).rows[0]!.calls, 2)
  } finally { await f.close() }
})

it('does not attach a newer memory revision to an older control-plane context snapshot', async () => {
  const { f, work, memory } = await setup()
  try {
    await f.store.addSteer(work.id, 'Synthetic revision before memory loading')
    await assert.rejects(memory.context(work, undefined, 'deep', 1), /request|revision|context/i)
    assert.equal((await memory.context(work, undefined, 'deep', 2)).admissionRequestVersion, 2)
  } finally { await f.close() }
})

it('captures the model input revision before publication waits and later context refreshes', async () => {
  const { f, work, memory, proof } = await setup(), budgets = new PgModelBudgetStore(f.pool, memory.admit)
  let release!: () => void
  try {
    let entered!: () => void, version = 1, wire = 0, settled = 0
    const waiting = new Promise<void>(r => { entered = r }), gate = new Promise<void>(r => { release = r })
    const versions: Array<number | undefined> = []
    const host: Pick<HostPort, 'reserveModelCall' | 'recordModelUsage'> = {
      reserveModelCall: (_work, id, limits) => { versions.push(limits.memoryRequestVersion); return budgets.reserve(work.id, id, limits, proof) },
      recordModelUsage: async (_work, id, usage) => { settled++; await budgets.record(work.id, id, usage.inputTokens, usage.outputTokens, usage.costMicros, proof) },
    }
    const unexpected = async (): Promise<never> => { throw new Error('unused') }
    const model = executionModel(host, { run: async () => { wire++; return { text: 'safe', output: [], usage: { available: true, inputTokens: 2, outputTokens: 1 } } },
      structured: unexpected, compact: unexpected }, work, DEFAULT_MODEL_BUDGET, undefined, 'model', undefined, () => version)
    const pending = model.run({ instructions: '', items: [], onAttempt: () => { entered(); return gate } })
    await waiting
    await f.store.addSteer(work.id, 'Synthetic revision during publication')
    await memory.context(work); version = 2
    release()
    await assert.rejects(pending, /request|revision|context/i)
    assert.deepEqual(versions, [1, 1]); assert.equal(wire, 0); assert.equal(settled, 1)
    const row = (await f.db.query<{ calls: number; tokens: number }>('SELECT model_calls::int AS calls,tokens::int FROM lingxios.agent_model_budgets')).rows[0]!
    assert.deepEqual(row, { calls: 1, tokens: 0 })
  } finally { release?.(); await f.close() }
})

it('rejects a request revision changed while memory inventory is in flight', async () => {
  const { f, work } = await setup()
  try {
    let entered!: () => void, resume!: () => void, held = false
    const waiting = new Promise<void>(r => { entered = r }), gate = new Promise<void>(r => { resume = r })
    const query: SqlPool['query'] = async (sql, params) => {
      const result = await f.pool.query(sql, params)
      if (!held && sql.includes('jsonb_agg(core)')) { held = true; entered(); await gate }
      return result
    }
    const memory = createMemoryRuntime({ query, connect: async () => ({ query, release() {} }) }, f.options)
    const pending = memory.context(work)
    await waiting
    await f.store.addSteer(work.id, 'Synthetic revision during inventory')
    resume()
    await assert.rejects(pending, /request|revision|context/i)
  } finally { await f.close() }
})

for (const reason of ['root-deadline', 'provider-deadline', 'user-cancel'] as const) it(`preserves ${reason} classification before a provider starts`, async () => {
  let release!: () => void, entered!: () => void, wire = 0, settled = 0, tokens: number | undefined
  const gate = new Promise<void>(r => { release = r }), started = new Promise<void>(r => { entered = r })
  const controller = new AbortController(), cancellation = new Error('synthetic user cancel')
  const host: Pick<HostPort, 'reserveModelCall' | 'recordModelUsage'> = {
    reserveModelCall: async () => ({ allowed: true, deadlineAt: new Date(Date.now() + 5000).toISOString(), remainingCalls: 9, remainingTokens: 100000, remainingCostMicros: 1000000 }),
    recordModelUsage: async (_work, _id, value) => { settled++; tokens = value.inputTokens + value.outputTokens },
  }
  const unexpected = async (): Promise<never> => { throw new Error('unused') }
  const model = executionModel(host, {
    recovery: { maxAttempts: 2, totalTimeoutMs: reason === 'provider-deadline' ? 30 : 1000 },
    run: async () => { wire++; return { text: 'safe', output: [], usage: { available: true, inputTokens: 2, outputTokens: 1 } } },
    structured: unexpected, compact: unexpected,
  }, { id: 'gate', tenantId: 't', agentId: 'a', principalId: 'u', sessionId: 's', fence: 1, homeEpoch: 1, kind: 'turn', lane: 'interactive', triggerRef: 'm', leaseToken: 'lease' },
  { ...DEFAULT_MODEL_BUDGET, wallClockMs: reason === 'root-deadline' ? 30 : 1000 }, undefined, 'model', undefined, () => true)
  const alive = setTimeout(() => {}, 1000)
  try {
    const pending = model.run({ instructions: '', items: [], signal: controller.signal, onAttempt: () => { entered(); return gate } })
    await started
    if (reason === 'user-cancel') controller.abort(cancellation)
    let failure: unknown
    try { await pending } catch (error) { failure = error }
    release(); await new Promise<void>(r => setImmediate(r))
    assert.equal(wire, 0); assert.equal(settled, 1); assert.equal(tokens, 0)
    if (reason === 'root-deadline') {
      assert.ok(failure instanceof ModelBudgetExceededError)
      assert.equal(failure.diagnostics.dimension, 'deadline')
    } else if (reason === 'provider-deadline') {
      assert.ok(failure instanceof ModelDriverError)
      assert.equal(failure.diagnostics.category, 'timeout')
    } else assert.equal(failure, cancellation)
  } finally { clearTimeout(alive); release() }
})
