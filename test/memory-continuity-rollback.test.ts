import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { it } from 'node:test'
import { memoryFixture, content, identity, scope } from './memory-fixture.js'

const rollback = () => readFile(new URL('../../db/migrations/015-memory-continuity-rollback.sql', import.meta.url), 'utf8')
it('rejects native rollback when stable forgetting is the only remaining activation state', async () => {
  const f = await memoryFixture({ resolveScopes: async () => [{ ...scope, continuity: 'principal' }] }, 'schema-013.sql')
  try {
    const stable = (await f.api.scopes(identity))[0]!
    await f.api.initialize(identity, { scope: stable, documents: [content()], idempotencyKey: 'seed', sourceRef: 'settings' })
    await f.api.forget(identity, stable)
    const counts = (await f.db.query<{ documents: number; moves: number; segments: number; fences: number }>(`SELECT
      (SELECT count(*)::int FROM lingxios.agent_memories) AS documents,
      (SELECT count(*)::int FROM lingxios.agent_memory_scope_moves) AS moves,
      (SELECT count(*)::int FROM lingxios.agent_memory_evidence_segments) AS segments,
      (SELECT count(*)::int FROM lingxios.agent_memory_scopes WHERE epoch>0 AND forgotten_at IS NOT NULL) AS fences`)).rows[0]!
    assert.deepEqual(counts, { documents: 0, moves: 0, segments: 0, fences: 1 })
    await assert.rejects(f.db.exec(await rollback()), /continuity is activated/)
    await f.db.exec('ROLLBACK')
    assert.equal((await f.db.query<{ version: number }>('SELECT version FROM lingxios.schema_version')).rows[0]!.version, 13)
    assert.equal((await f.db.query<{ epoch: number }>('SELECT epoch FROM lingxios.agent_memory_scopes')).rows[0]!.epoch, 1)
  } finally { await f.close() }
})
it('keeps empty pre-activation rollback available and rejects epoch or timestamp fences independently', async () => {
  const f = await memoryFixture({}, 'schema-013.sql')
  try {
    const sql = await rollback()
    await f.db.exec(sql)
    assert.equal((await f.db.query<{ version: number }>('SELECT version FROM lingxios.schema_version')).rows[0]!.version, 12)
    await f.db.exec("UPDATE lingxios.schema_version SET version=13; INSERT INTO lingxios.agent_memory_scopes(tenant_id,scope_type,scope_id,epoch) VALUES('t','user','stable-memory:test',1)")
    await assert.rejects(f.db.exec(sql), /continuity is activated/); await f.db.exec('ROLLBACK')
    await f.db.exec("UPDATE lingxios.agent_memory_scopes SET epoch=0,forgotten_at=clock_timestamp()")
    await assert.rejects(f.db.exec(sql), /continuity is activated/); await f.db.exec('ROLLBACK')
    assert.equal((await f.db.query<{ version: number }>('SELECT version FROM lingxios.schema_version')).rows[0]!.version, 13)
  } finally { await f.close() }
})
