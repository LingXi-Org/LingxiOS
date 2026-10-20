import assert from 'node:assert/strict'
import { it } from 'node:test'
import { memoryFixture, scope } from './memory-fixture.js'
import { createLingxiOS } from '../src/app/index.js'
import { AgentRuntime } from '../src/runtime/runtime.js'
import { summaryItem } from '../src/runtime/compaction.js'
import type { ModelDriver } from '../src/model/driver.js'
import type { ModelItem } from '../src/protocol/types.js'
import { maintainStorage } from '../src/app/maintenance.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Formal 3.5.6 stored full memorySnapshot arrays in model.started; the later
// diagnostic projection stores counts. An old implicit exposure has no native
// memory action, and its summary must not acquire a clean proof after forget.
for (const format of ['counts', 'core', 'directory', 'recalled', 'strategies', 'expired-counts']) {
  it(`invalidates an unproven summary after ${format} snapshot exposure without a memory tool`, async () => {
    const fixture = await memoryFixture()
    const api = await createLingxiOS({ database: fixture.pool, memory: fixture.options,
      background: { role: 'passive' }, performance: { notifications: false } })
    try {
      const identity = { tenantId: 't', agentId: 'a', principalId: 'u', sessionId: 'legacy-room' }
      const host = api.connectWorker({ workerId: 'legacy-fixture', workKinds: ['turn'] })
      const inputs: ModelItem[][] = []
      const model: ModelDriver = {
        modelId: 'synthetic-local', compact: async () => { throw new Error('unexpected compaction') },
        structured: async () => { throw new Error('unexpected structured call') },
        run: async request => {
          inputs.push([...request.items])
          return { text: 'Done.', output: [], usage: { available: true, inputTokens: 1, outputTokens: 1 } }
        },
      }
      const run = async (id: string) => {
        await api.enqueue({ ...identity, id, text: 'Reply Done.', mode: 'read', codeExecution: 'disabled', deliveryMode: 'text' })
        const work = await host.claimWork()
        assert.equal(work?.id, id)
        await new AgentRuntime(host, model, { execute: async () => { throw new Error('unexpected kernel') } }).runWork(work!)
        assert.equal((await fixture.db.query<{ status: string }>(
          'SELECT status FROM lingxios.agent_work_items WHERE id=$1', [id])).rows[0]?.status, 'succeeded')
      }
      await run('seed')
      inputs.length = 0
      const marker = 'SYNTHETIC_LEGACY_MEMORY_ONLY'
      const summary = JSON.stringify({ version: 1, fields: { observedResults: marker, decisions: '', remainingWork: '', uncertainties: '' }, truncated: [] })
      // Explicit historical-format installation, not a claim to have run the old binary.
      await fixture.db.query('UPDATE lingxios.agent_os_sessions SET summary=$1,history=$2::jsonb',
        [summary, JSON.stringify([summaryItem(summary)])])
      const snapshot = format === 'counts' || format === 'expired-counts' ? { counts: { core: 1, directory: 0, recalled: 0, strategies: 0 } }
        : { status: 'available', core: [], directory: [], recalled: [], strategies: [], [format]: [{ body: marker }] }
      await fixture.db.query(`INSERT INTO lingxios.agent_run_events(run_id,seq,tenant_id,agent_id,kind,stage,visibility,data)
        VALUES('seed',100,'t','a','model.started','started','internal',$1::jsonb)`, [JSON.stringify({ memorySnapshot: snapshot })])
      if (format === 'expired-counts') {
        const homes = await mkdtemp(join(tmpdir(), 'lingxios-legacy-expiry-test-'))
        try {
          await fixture.db.query("UPDATE lingxios.agent_run_events SET expires_at=NOW()-INTERVAL '1 day' WHERE run_id='seed' AND seq=100")
          assert.equal((await maintainStorage(fixture.pool, homes)).expiredEvents, 1)
        } finally { await rm(homes, { recursive: true, force: true }) }
      }
      const before = JSON.stringify((await fixture.db.query('SELECT history,summary FROM lingxios.agent_os_sessions')).rows)
      await api.memory!.forget(identity, scope)
      assert.equal(JSON.stringify((await fixture.db.query('SELECT history,summary FROM lingxios.agent_os_sessions')).rows), before)
      await run('after-forget')
      assert.equal((await fixture.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM lingxios.agent_action_intents
        WHERE intent->'action'->>'action' LIKE 'memory.%'`)).rows[0]?.n, 0)
      assert.equal((await fixture.db.query<{ n: number }>('SELECT count(*)::int AS n FROM lingxios.agent_memories')).rows[0]?.n, 0)
      assert.equal(inputs.length, 1)
      assert.equal(JSON.stringify(inputs).includes(marker), false, 'only the model projection loses the old memory')
      assert.equal((await fixture.db.query<{ summary: string }>('SELECT summary FROM lingxios.agent_os_sessions')).rows[0]?.summary, summary)
    } finally { await api.stop(); await fixture.close() }
  })
}
