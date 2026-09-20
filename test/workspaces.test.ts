import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS } from '../src/app/index.js'
import { bytesHash, type RuntimeObjectStore } from '../src/app/object-store.js'
import { captureWorkspace, restoreWorkspace } from '../src/kernel/workspace.js'
import { DEFAULT_WORKSPACE_LIMITS, checkedWorkspaceEntries, type WorkspaceEntry } from '../src/protocol/workspace.js'
import { sessionKeyOf } from '../src/protocol/types.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import { snapshotRequest } from '../src/context/request.js'
import { migrateLocalRuntimeFiles } from '../src/index.js'
import { kernelHome } from '../src/kernel/manager.js'
import { stageArtifact, artifactObjectKey } from '../src/app/artifacts.js'

function objects() {
  const data = new Map<string, Uint8Array>()
  let fail = false
  const store: RuntimeObjectStore = {
    async put(key, bytes) { if (fail) throw new Error('object store unavailable'); data.set(key, Uint8Array.from(bytes)) },
    async get(key, max) { const bytes = data.get(key); if (bytes && bytes.length > max) throw new Error('too large'); return bytes ?? null },
    async delete(key) { data.delete(key) }, async list() { return { objects: [] } },
  }
  return { store, data, fail: () => { fail = true } }
}

it('restores additions, overwritten and deleted files; only uploads changed bytes and rejects corrupt or linked trees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lingxios-workspace-')), a = join(root, 'a'), b = join(root, 'b')
  const signal = AbortSignal.timeout(20_000), storage = objects(), limits = { ...DEFAULT_WORKSPACE_LIMITS }
  const upload = async (path: string, bytes: Uint8Array): Promise<Extract<WorkspaceEntry, { kind: 'file' }>> => {
    const sha256 = bytesHash(bytes), objectKey = `workspaces/${'a'.repeat(64)}/${'b'.repeat(64)}-1/${randomUUID()}/${sha256}`
    await storage.store.put(objectKey, bytes, signal)
    return { kind: 'file', path, size: bytes.length, sha256, objectKey }
  }
  const read = async (entry: Extract<WorkspaceEntry, { kind: 'file' }>) => (await storage.store.get(entry.objectKey, entry.size, signal))!
  try {
    await mkdir(join(a, 'nested'), { recursive: true }); await writeFile(join(a, 'nested', '保持.txt'), 'unchanged')
    await writeFile(join(a, 'change.txt'), 'before'); await writeFile(join(a, 'delete.txt'), 'remove')
    const first = { generation: 1, entries: await captureWorkspace(a, { generation: 0, entries: [] }, limits, upload, signal) }
    await restoreWorkspace(b, first, limits, read, signal)
    assert.equal(await readFile(join(b, 'nested', '保持.txt'), 'utf8'), 'unchanged')
    await unlink(join(a, 'delete.txt')); await writeFile(join(a, 'change.txt'), 'after')
    await mkdir(join(a, 'empty')); await writeFile(join(a, 'new.txt'), 'new')
    const second = { generation: 2, entries: await captureWorkspace(a, first, limits, upload, signal) }
    assert.equal(storage.data.size, 5)
    await restoreWorkspace(b, second, limits, read, signal)
    assert.equal(await readFile(join(b, 'change.txt'), 'utf8'), 'after')
    await assert.rejects(readFile(join(b, 'delete.txt')), { code: 'ENOENT' })
    await assert.rejects(restoreWorkspace(b, second, limits, async () => Buffer.from('corrupt'), signal), /hash/)
    assert.equal(await readFile(join(b, 'change.txt'), 'utf8'), 'after')
    await link(join(a, 'change.txt'), join(a, 'linked.txt'))
    await assert.rejects(captureWorkspace(a, second, limits, upload, signal), /link/)
    await unlink(join(a, 'linked.txt'))
    await assert.rejects(captureWorkspace(a, second, { ...limits, maxBytes: 1 }, upload, signal), /limits/)
    assert.throws(() => checkedWorkspaceEntries([{ kind: 'directory', path: '../outside' }], limits), /path/)
    assert.throws(() => checkedWorkspaceEntries([{ kind: 'directory', path: 'a/b' }], limits), /parent/)
    await assert.rejects(restoreWorkspace(a, { generation: 0, entries: [] }, limits, read, signal), /migration/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('imports drained legacy files explicitly, verifies shared bytes and refuses missing or changed source directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lingxios-import-')), db = new PGlite(), storage = objects()
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  const query: SqlPool['query'] = async (sql, params) => { const result = await db.query<Record<string, unknown>>(sql, params); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length } }
  const pool: SqlPool = { query, connect: async () => ({ query, release() {} }) }
  const app = await createLingxiOS({ database: pool, homesRoot: root, performance: { notifications: false } })
  try {
    const identity = { runId: 'legacy', tenantId: 'tenant', agentId: 'agent', sessionId: 'room', principalId: 'human' }
    await app.enqueue({ ...identity, id: identity.runId, text: 'Keep legacy bytes' })
    const host = app.connectWorker({ workerId: 'a', workKinds: ['turn'] }), work = (await host.claimWork())!
    await host.saveSession(work, { key: sessionKeyOf(work), tenantId: work.tenantId, agentId: work.agentId, sessionId: work.sessionId,
      revision: 0, compactionEpoch: 0, history: [], appliedWorkIds: [work.id], request: snapshotRequest(await host.loadContext(work)) })
    const bytes = Buffer.from('old bytes'), artifact = { path: 'old.txt', size: bytes.length, sha256: bytesHash(bytes), mime: 'text/plain' }
    await stageArtifact(root, work, artifact, bytes)
    const home = kernelHome(root, work)
    await mkdir(home, { recursive: true }); await writeFile(join(home, 'old.txt'), bytes)
    await pool.query(`INSERT INTO lingxios.agent_results(id,work_id,request_version,fence,home_epoch,message)
      VALUES('legacy-result',$1,1,$2,$3,$4::jsonb)`, [work.id, work.fence, work.homeEpoch, JSON.stringify({ body: 'file', envelope: { artifacts: [artifact] } })])
    const options = { database: pool, objects: storage.store, homesRoot: root, workId: work.id }
    await assert.rejects(migrateLocalRuntimeFiles({ ...options, kind: 'workspace' }), /drained/)
    await pool.query("UPDATE lingxios.agent_work_items SET status='succeeded',result_id='legacy-result',lease_token_hash=NULL,lease_expires_at=NULL WHERE id=$1", [work.id])
    assert.deepEqual((await migrateLocalRuntimeFiles({ ...options, kind: 'artifacts' })).artifacts, [{ path: 'old.txt', size: bytes.length, sha256: artifact.sha256 }])
    const imported = await migrateLocalRuntimeFiles({ ...options, kind: 'workspace' })
    assert.equal(imported.workspace?.generation, 1)
    assert.deepEqual(await migrateLocalRuntimeFiles({ ...options, kind: 'workspace' }), imported)
    const remote = await createLingxiOS({ database: pool, objects: storage.store, workspace: {}, performance: { notifications: false } })
    try {
      assert.equal((await remote.readArtifact(identity, 'old.txt'))?.bytes.toString(), 'old bytes')
      assert.equal(await remote.readArtifact({ ...identity, principalId: 'other' }, 'old.txt'), null)
      storage.data.set(artifactObjectKey(identity, artifact), Buffer.from('corrupted'))
      await assert.rejects(remote.readArtifact(identity, 'old.txt'), /commitment/)
    } finally { await remote.stop() }
    await writeFile(join(home, 'old.txt'), 'changed after migration')
    await assert.rejects(migrateLocalRuntimeFiles({ ...options, kind: 'workspace' }), /differs/)
    await rm(home, { recursive: true })
    await assert.rejects(migrateLocalRuntimeFiles({ ...options, kind: 'workspace' }), { code: 'ENOENT' })
  } finally { await app.stop(); await db.close(); await rm(root, { recursive: true, force: true }) }
})

it('commits file references with completed steps, fences old workers, and preserves the prior checkpoint on failed uploads', async () => {
  const db = new PGlite(), storage = objects()
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  let tail = Promise.resolve()
  const acquire = async () => { let release!: () => void; const previous = tail; tail = new Promise<void>(resolve => { release = resolve }); await previous; return release }
  const query: SqlPool['query'] = async (sql, params) => { const result = await db.query<Record<string, unknown>>(sql, params); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length } }
  const pool: SqlPool = {
    async query(sql, params) { const release = await acquire(); try { return await query(sql, params) } finally { release() } },
    async connect() { return { query, release: await acquire() } },
  }
  const app = await createLingxiOS({ database: pool, objects: storage.store, workspace: {}, performance: { notifications: false } })
  try {
    await app.enqueue({ id: 'workspace-run', tenantId: 'tenant', agentId: 'agent', sessionId: 'room', principalId: 'human', text: 'Keep files' })
    const a = app.connectWorker({ workerId: 'a', workKinds: ['turn'] }), b = app.connectWorker({ workerId: 'b', workKinds: ['turn'] })
    const work = (await a.claimWork())!
    await a.saveSession(work, { key: sessionKeyOf(work), tenantId: work.tenantId, agentId: work.agentId, sessionId: work.sessionId,
      revision: 0, compactionEpoch: 0, history: [], appliedWorkIds: [work.id], request: snapshotRequest(await a.loadContext(work)) })
    const file = await a.stageWorkspaceFile!(work, 'notes.txt', Buffer.from('safe checkpoint'))
    const step = { id: 'cell-1', kind: 'ipython', requestVersion: 1, input: { code: 'write file' }, output: '{}', artifacts: [],
      workspace: { baseGeneration: 0, entries: [file] } }
    await a.saveStep(work, step); await a.saveStep(work, step)
    assert.deepEqual((await b.loadWorkspace!(work))?.snapshot, { generation: 1, entries: [file] })
    assert.equal(Buffer.from(await b.readWorkspaceFile!(work, file)).toString(), 'safe checkpoint')
    await assert.rejects(a.saveStep(work, { ...step, id: 'missing', workspace: undefined } as never), /require a workspace checkpoint/)
    await pool.query("UPDATE lingxios.agent_work_items SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [work.id])
    await pool.query("UPDATE lingxios.agent_os_session_leases SET expires_at=NOW()-INTERVAL '1 second'")
    const recovered = (await b.claimWork())!
    assert.ok(recovered.fence > work.fence && recovered.homeEpoch > work.homeEpoch)
    await assert.rejects(a.saveStep(work, { ...step, id: 'stale', workspace: { baseGeneration: 1, entries: [] } }), /lease/)
    assert.equal((await b.loadWorkspace!(recovered))?.snapshot.generation, 1)
    const pending = { id: 'cell-2', kind: 'ipython', requestVersion: 1, input: {}, artifacts: [] }
    await b.saveStep(recovered, pending)
    storage.fail()
    await assert.rejects(b.stageWorkspaceFile!(recovered, 'lost.txt', Buffer.from('uncommitted')), /unavailable/)
    assert.equal((await pool.query('SELECT output FROM lingxios.agent_steps WHERE step_id=$1', [pending.id])).rows[0]?.['output'], null)
    await b.saveStep(recovered, { ...pending, output: '{}', workspace: { baseGeneration: 1, entries: [] } })
    assert.deepEqual((await b.loadWorkspace!(recovered))?.snapshot, { generation: 2, entries: [] })
    await assert.rejects(b.readWorkspaceFile!(recovered, file), /outside/)
  } finally { await app.stop(); await db.close() }
})
