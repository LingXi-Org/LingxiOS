import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { createLingxiOS, packageResources } from '@lyyzka/lingxios'
import { HttpHostClient } from '../dist/src/host/http-client.js'
import { sessionKeyOf } from '../dist/src/protocol/types.js'
import { snapshotRequest } from '../dist/src/context/request.js'
import { nullLogger } from '../dist/src/logging.js'

const connectionString = process.env.LINGXIOS_WORKSPACE_TEST_DATABASE_URL
assert.ok(connectionString, 'configure an empty disposable PostgreSQL database')
const pool = new Pool({ connectionString, max: 12 }), bytes = new Map()
let fail = false, a, b
const objects = {
  async put(key, value) { if (fail) throw new Error('object store offline'); bytes.set(key, Uint8Array.from(value)) },
  async get(key) { return bytes.get(key) ?? null }, async delete(key) { bytes.delete(key) },
  async list() { return { objects: [...bytes.keys()].map(key => ({ key, updatedAt: new Date(0).toISOString() })) } },
}
try {
  assert.equal((await pool.query("SELECT tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")).rows.length, 0)
  await pool.query(await readFile(packageResources().schema, 'utf8'))
  a = await createLingxiOS({ database: pool, objects, workspace: {}, logger: nullLogger })
  b = await createLingxiOS({ database: pool, objects, workspace: {}, logger: nullLogger })
  const token = 'disposable-control-token', portA = await a.listenControlPlane({ port: 0, serviceToken: token }), portB = await b.listenControlPlane({ port: 0, serviceToken: token })
  const host = (port, workerId) => new HttpHostClient({ baseUrl: `http://127.0.0.1:${port}`, serviceToken: token, workerId })
  const ha = host(portA, 'a'), hb = host(portB, 'b')
  await a.enqueue({ id: 'w', tenantId: 't', agentId: 'a', principalId: 'u', sessionId: 's', text: 'write files' })
  const work = await ha.claimWork()
  assert.ok(work)
  await ha.saveSession(work, { key: sessionKeyOf(work), tenantId: 't', agentId: 'a', sessionId: 's', revision: 0,
    compactionEpoch: 0, history: [], appliedWorkIds: [work.id], request: snapshotRequest(await ha.loadContext(work)) })
  await b.enqueue({ id: 'same-session', tenantId: 't', agentId: 'a', principalId: 'u', sessionId: 's', text: 'wait for ownership' })
  assert.equal(await hb.claimWork(), null, 'the second worker must not execute the same session concurrently')
  const file = await ha.stageWorkspaceFile(work, 'large.bin', Buffer.alloc(1024 * 1024, 7))
  const step = { id: 'c1', kind: 'ipython', requestVersion: 1, input: { code: 'write file' }, output: '{}', artifacts: [], workspace: { baseGeneration: 0, entries: [file] } }
  const saves = await Promise.allSettled([ha.saveStep(work, step), hb.saveStep(work, { ...step, id: 'c2' })])
  assert.equal(saves.filter(result => result.status === 'fulfilled').length, 1, 'only one CAS winner may commit a step and manifest')
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM lingxios.agent_steps WHERE output IS NOT NULL')).rows[0].n, 1)
  const winner = saves[0].status === 'fulfilled' ? step : { ...step, id: 'c2' }
  await ha.saveStep(work, winner)
  assert.equal((await hb.loadWorkspace(work)).snapshot.generation, 1)
  assert.deepEqual(Buffer.from(await hb.readWorkspaceFile(work, file)), Buffer.alloc(1024 * 1024, 7))
  await assert.rejects(hb.readWorkspaceFile(work, { ...file, objectKey: file.objectKey + 'invalid' }))
  await assert.rejects(hb.readWorkspaceFile(work, { ...file, size: 0 }))
  await assert.rejects(hb.readWorkspaceFile(work, { ...file, sha256: '0'.repeat(64) }))
  await pool.query("UPDATE lingxios.agent_work_items SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id='w'")
  await pool.query("UPDATE lingxios.agent_os_session_leases SET expires_at=NOW()-INTERVAL '1 second'")
  // SKIP LOCKED can return an empty poll while a control-plane transaction owns a row.
  let recovered
  const deadline = Date.now() + 5_000
  do { recovered = await hb.claimWork(); if (!recovered) await delay(25) } while (!recovered && Date.now() < deadline)
  assert.ok(recovered, JSON.stringify({
    work: (await pool.query('SELECT id,status,leased_by,lease_expires_at,available_at,cancel_requested_at FROM lingxios.agent_work_items')).rows,
    leases: (await pool.query('SELECT * FROM lingxios.agent_os_session_leases')).rows,
    now: (await pool.query('SELECT NOW()')).rows,
  }))
  assert.equal(recovered.id, work.id)
  assert.ok(recovered.fence > work.fence && recovered.homeEpoch > work.homeEpoch)
  await assert.rejects(ha.saveStep(work, { ...step, id: 'late', workspace: { baseGeneration: 1, entries: [] } }))
  const orphan = await hb.stageWorkspaceFile(recovered, 'orphan.bin', Buffer.from('uploaded before a crash'))
  assert.equal((await hb.loadWorkspace(recovered)).snapshot.generation, 1)
  fail = true
  await assert.rejects(hb.stageWorkspaceFile(recovered, 'failure.bin', Buffer.from('not committed')))
  assert.equal((await hb.loadWorkspace(recovered)).snapshot.generation, 1)
  fail = false
  await hb.saveStep(recovered, { ...step, id: 'delete', workspace: { baseGeneration: 1, entries: [] } })
  assert.deepEqual((await ha.loadWorkspace(recovered)).snapshot, { generation: 2, entries: [] })
  await assert.rejects(hb.readWorkspaceFile(recovered, file))
  await a.maintenance()
  assert.ok(bytes.has(orphan.objectKey), 'active attempt uploads survive garbage collection')
  await hb.completeWork(recovered, { status: 'failed', error: 'end of isolated test' })
  await b.maintenance()
  assert.equal(bytes.size, 0, 'unreferenced old uploads are removed after the attempt ends')
  console.log('Real PostgreSQL + two HTTP control planes: binary file transfer, session exclusion, atomic checkpoint CAS, retry, stale fence, recovery, deletion and bounded orphan cleanup passed')
} finally { await a?.stop(); await b?.stop(); await pool.end() }
