import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { it } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS } from '../src/app/index.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import { NoEffectError } from '../src/tools/definition.js'

it('degrades only optional memory dependency/authorization failures while keeping mandatory authorization and explicit operations strict', async () => {
  const db = new PGlite()
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url),'utf8'))
  let memoryReads = 0, fault: Error = Object.assign(new Error('PRIVATE_SQL'),{ code: '57014' }), mandatoryDenied = false
  const pool: SqlPool = { async query(sql,params) {
    if (sql.includes('FROM lingxios.agent_memories')) memoryReads++
    const result = await db.query<Record<string, unknown>>(sql,params)
    return { rows: result.rows,rowCount: result.affectedRows ?? result.rows.length }
  },connect: async () => ({ query: pool.query,release() {} }) }
  const app = await createLingxiOS({ database: pool,background: { role: 'passive' },
    contextProvider: { loadContext: async () => {
      if (mandatoryDenied) throw new NoEffectError('PRIVATE_SCOPE','forbidden')
      return { persona: { name: 'A',role: '',instructions: '' },capabilities: [],messages: [] }
    } }, memory: { resolveScopes: async () => { throw fault } } })
  try {
    const identity = { tenantId: 'tenant',agentId: 'agent',principalId: 'human',sessionId: 'session' }
    await app.enqueue({ ...identity,id: 'optional-memory',text: 'Explain a general concept.' })
    const host = app.connectWorker({ workerId: 'fixture',workKinds: ['turn'] }), work = (await host.claimWork())!
    memoryReads = 0 // Exclude the startup schema probe, which selects no memory rows.
    for (const current of [fault,Object.assign(new Error('PRIVATE_NETWORK'),{ code: 'ECONNRESET' }),
      new DOMException('PRIVATE_TIMEOUT','TimeoutError'),new NoEffectError('PRIVATE_SCOPE','forbidden')]) {
      fault = current
      const context = await host.loadContext(work)
      assert.equal(context.memory?.status,'unavailable')
      assert.deepEqual(context.memory?.core,[])
      assert.deepEqual(context.memory?.recalled,[])
      assert.doesNotMatch(JSON.stringify(context.memory),/PRIVATE_/)
      assert.equal(memoryReads,0)
      await assert.rejects(app.memory!.scopes({ ...identity,workId: work.id }))
    }
    fault = new TypeError('PRIVATE_IMPLEMENTATION')
    await assert.rejects(host.loadContext(work),error => error === fault)
    mandatoryDenied = true
    await assert.rejects(host.loadContext(work),error => error instanceof NoEffectError && error.code === 'forbidden')
    assert.equal(memoryReads,0)
    const aborted = new AbortController(); aborted.abort()
    await assert.rejects(host.loadContext(work,aborted.signal))
  } finally { await app.stop(); await db.close() }
})
