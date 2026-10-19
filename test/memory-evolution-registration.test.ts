import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createMemoryRuntime } from '../src/memory/runtime.js'
import { freezeEvolutionBenchmark, type EvolutionBenchmark } from '../src/memory/evolution.js'
import type { MemoryOptions } from '../src/index.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import { toolExecutor } from '../src/tools/executor.js'
import { toolContractHash } from '../src/tools/contracts.js'
import { memoryFixture, content, identity, scope } from './memory-fixture.js'

const definition = (): EvolutionBenchmark => ({ id: 'trusted-v1', evaluatorVersion: 'fixture-v1', repetitions: 2,
  gates: ['authorization','approval','isolation','no_code_mutation'], cases: [
    { id: 'target-a', split: 'target', input: { fixture: 'a' } },
    { id: 'target-b', split: 'target', input: { fixture: 'b' } },
    { id: 'holdout-a', split: 'holdout', input: { fixture: 'c' } },
    { id: 'holdout-b', split: 'holdout', input: { fixture: 'd' } },
  ] })
// Structural assignment lets the same executable regression run against 3.5.4.
const evolutionOption = (benchmark = definition()) => ({ benchmarkId: benchmark.id, benchmark })
const candidate = { kind: 'strategy', scopeType: 'user', body: 'Inspect current receipts before retrying.' }
const registry = /\bagent_evolution_benchmarks\b/

async function fixture(evolution: NonNullable<MemoryOptions['evolution']> = evolutionOption()) {
  let revoked = false, rejectRegistry = false, registryQueries = 0, globalQueries = 0
  const f = await memoryFixture({ evolution, resolveScopes: async () => revoked ? [] : [scope] })
  const query: SqlPool['query'] = async (sql, params) => {
    if (registry.test(sql)) { registryQueries++; assert.equal(rejectRegistry, false, 'unexpected benchmark registry access') }
    return f.pool.query(sql, params)
  }
  const pool: SqlPool = {
    query: async (sql, params) => { globalQueries++; return query(sql, params) },
    connect: async () => ({ query, release() {} }),
  }
  const runtime = createMemoryRuntime(pool, f.options)
  const executor = toolExecutor(pool, runtime.tools)
  const source = await f.source()
  await f.db.query(`INSERT INTO lingxios.agent_results(id,work_id,request_version,fence,home_epoch,message)
    VALUES($1,$2,1,0,1,$3::jsonb)`, ['result:source', source.work.id, JSON.stringify(source.message)])
  await f.db.query('UPDATE lingxios.agent_work_items SET result_id=$2 WHERE id=$1', [source.work.id, 'result:source'])
  const { job } = await f.reflection()
  assert.ok(job)
  let sequence = 0
  const action = async (method: string, args: Record<string, unknown>, customExecutor = executor,
    signal = new AbortController().signal, timeoutMs = 10_000) => {
    const id = `action:${++sequence}`
    const action = { idempotencyKey: id, runId: job.id, cellId: 'synthesis', callIndex: sequence, action: `memory_synthesis.${method}`, args }
    await f.db.query('INSERT INTO lingxios.agent_action_intents(idempotency_key,fingerprint,intent) VALUES($1,$2,$3::jsonb)',
      [id, id, JSON.stringify({ workId: job.id, requestVersion: 1, action,
        toolContractHash: toolContractHash(runtime.tools.find(tool => tool.action === action.action)!) })])
    return { id, execute: () => customExecutor.execute(job, action, { requestVersion: 1, signal,
      deadlineAt: new Date(Date.now() + timeoutMs).toISOString() }) }
  }
  const invoke = async (method: string, args: Record<string, unknown>) => (await action(method, args)).execute()
  await invoke('load', {})
  const input = { changes: [{ sourceRunIds: [source.work.id], change: { action: 'create', content: content() } }],
    approved: true, confidence: 1, candidates: [candidate] }
  const count = async (table: string) => Number((await f.db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM lingxios.${table}`)).rows[0]!.count)
  const assertRolledBack = async (id: string) => {
    assert.equal(await count('agent_memories'), 0)
    assert.equal(await count('agent_evolution_evaluations'), 0)
    assert.deepEqual((await f.db.query('SELECT status FROM lingxios.agent_memory_evidence_scopes')).rows, [{ status: 'pending' }])
    assert.deepEqual((await f.db.query('SELECT status FROM lingxios.agent_memory_evidence')).rows, [{ status: 'pending' }])
    assert.equal((await f.db.query('SELECT 1 FROM lingxios.agent_action_ledger WHERE idempotency_key=$1', [id])).rows.length, 0)
  }
  return { ...f, pool, runtime, job, sourceRun: source, input, action, invoke, count, assertRolledBack,
    revoke: () => { revoked = true }, rejectRegistry: () => { rejectRegistry = true },
    registryQueries: () => registryQueries, globalQueries: () => globalQueries }
}

it('freezes a cold tenant benchmark and proposes inactive candidates in the same synthesis action transaction', async () => {
  const f = await fixture()
  try {
    assert.equal(await f.count('agent_evolution_benchmarks'), 0)
    assert.equal(f.registryQueries(), 0, 'load must not register')
    const before = f.globalQueries()
    const action = await f.action('apply', f.input)
    assert.deepEqual((await action.execute()).value, { outcome: 'committed', changeCount: 1 })
    assert.equal(f.globalQueries(), before, 'freeze/proposal cannot escape to the global pool')
    assert.equal(await f.count('agent_evolution_benchmarks'), 1)
    assert.equal(await f.count('agent_evolution_evaluations'), 1)
    assert.deepEqual((await f.db.query('SELECT origin,status FROM lingxios.agent_memories ORDER BY origin')).rows,
      [{ origin: 'evolved', status: 'candidate' }, { origin: 'synthesized', status: 'active' }])
    assert.equal((await f.db.query('SELECT 1 FROM lingxios.agent_action_ledger WHERE idempotency_key=$1', [action.id])).rows.length, 1)
  } finally { await f.close() }
})

it('rejects a frozen definition conflict and rolls back memory, evidence, evaluation and the successful receipt', async () => {
  const f = await fixture()
  try {
    await freezeEvolutionBenchmark(f.pool, 't', { ...definition(), repetitions: 3 })
    const action = await f.action('apply', f.input)
    await assert.rejects(action.execute())
    await f.assertRolledBack(action.id)
    assert.equal(await f.count('agent_evolution_benchmarks'), 1)
    assert.equal((await f.db.query<{ definition: EvolutionBenchmark }>('SELECT definition FROM lingxios.agent_evolution_benchmarks')).rows[0]!.definition.repetitions, 3)
  } finally { await f.close() }
})

it('rejects mismatched trusted IDs before any database access', () => {
  const pool: SqlPool = { query: async () => { throw new Error('unexpected database access') }, connect: async () => { throw new Error('unexpected connection') } }
  assert.throws(() => createMemoryRuntime(pool, { resolveScopes: async () => [],
    evolution: { ...evolutionOption(), benchmarkId: 'another-id' } }), /benchmark.*(identity|ID|id).*match/i)
})

it('captures the trusted benchmark and ID before the caller can mutate nested options', async () => {
  const option = evolutionOption(), expected = structuredClone(option.benchmark)
  const f = await fixture(option)
  try {
    option.benchmark.cases[0]!.input = { altered: true }
    option.benchmark.id = 'changed-definition'
    option.benchmarkId = 'changed-reference'
    await f.invoke('apply', f.input)
    assert.deepEqual((await f.db.query('SELECT definition FROM lingxios.agent_evolution_benchmarks')).rows, [{ definition: expected }])
  } finally { await f.close() }
})

it('preserves benchmarkId-only registration requirements and explicit administrative freezing', async () => {
  const f = await fixture({ benchmarkId: definition().id })
  try {
    const missing = await f.action('apply', f.input)
    await assert.rejects(missing.execute())
    await f.assertRolledBack(missing.id)
    assert.equal(await f.count('agent_evolution_benchmarks'), 0)
    await freezeEvolutionBenchmark(f.pool, 't', definition())
    assert.equal((await f.invoke('apply', f.input)).ok, true)
    assert.equal(await f.count('agent_evolution_evaluations'), 1)
  } finally { await f.close() }
})

for (const mode of ['empty', 'rejected', 'processed', 'forgotten', 'revoked'] as const) it(`does not touch the benchmark registry for ${mode} synthesis`, async () => {
  const f = await fixture()
  try {
    f.rejectRegistry()
    if (mode === 'revoked') f.revoke()
    if (mode === 'forgotten') await f.api.forget(identity, scope)
    if (mode === 'processed') await f.invoke('apply', { ...f.input, candidates: [] })
    const input = { ...f.input, ...(mode === 'empty' ? { candidates: [] } : mode === 'rejected' ? { approved: false } : {}) }
    if (mode === 'revoked' || mode === 'forgotten') await assert.rejects(f.invoke('apply', input))
    else assert.equal((await f.invoke('apply', input)).ok, true)
    assert.equal(f.registryQueries(), 0)
    assert.equal(await f.count('agent_evolution_benchmarks'), 0)
    assert.equal(await f.count('agent_evolution_evaluations'), 0)
  } finally { await f.close() }
})

it('ordinary cold and warm memory reads and context do not access the registry', async () => {
  const f = await fixture()
  try {
    f.rejectRegistry()
    const turn = await f.source({ leased: true, capture: false })
    for (let pass = 0; pass < 2; pass++) {
      assert.deepEqual(await f.runtime.api.scopes(identity), [scope])
      assert.equal((await f.runtime.api.list(identity, scope)).items.length, 0)
      assert.equal((await f.runtime.context(turn.work)).status, 'available')
    }
    assert.equal(f.registryQueries(), 0)
  } finally { await f.close() }
})

for (const mode of ['cancel', 'deadline'] as const) it(`discards the shared action connection when ${mode} interrupts freezing and permits a later action`, async () => {
  const f = await fixture()
  let rollback: Promise<unknown> | undefined
  try {
    const controller = new AbortController()
    let reached = false, discarded = 0, releasePending: ((reason: Error) => void) | undefined
    const pool: SqlPool = { query: async () => { throw new Error('freeze escaped the transaction') }, connect: async () => ({
      query: async (sql, params) => {
        if (/INSERT INTO lingxios.agent_evolution_benchmarks/.test(sql)) {
          reached = true
          if (mode === 'cancel') setImmediate(() => controller.abort(new Error('fixture cancelled')))
          return new Promise((_, reject) => { releasePending = reject })
        }
        return f.pool.query(sql, params)
      },
      release: error => {
        if (error) {
          discarded++
          // PGlite has one embedded connection; model pg's discard rollback explicitly.
          rollback = f.db.exec('ROLLBACK')
          releasePending?.(error)
        }
      },
    }) }
    const runtime = createMemoryRuntime(pool, f.options)
    const action = await f.action('apply', f.input, toolExecutor(pool, runtime.tools), controller.signal, mode === 'deadline' ? 250 : 5000)
    // Keep the test process alive for the production deadline's unref'ed timer.
    const keepAlive = setInterval(() => {}, 1000)
    try { await assert.rejects(action.execute()) } finally { clearInterval(keepAlive) }
    await rollback
    assert.equal(reached, true, 'must actually wait at the benchmark write')
    assert.equal(discarded, 1)
    await f.assertRolledBack(action.id)
    assert.equal(await f.count('agent_evolution_benchmarks'), 0)
    assert.equal((await f.invoke('apply', f.input)).ok, true)
  } finally { await f.close() }
})
