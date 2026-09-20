import { realpath } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { artifactDirectory, artifactObjectKey, checkedFile } from './artifacts.js'
import { objectSignal, readCheckedObject, type RuntimeObjectStore } from './object-store.js'
import { createWorkspaceStore } from './workspaces.js'
import { withTransaction, workItemFromRow, type SqlPool } from '../control-plane/pg-store.js'
import { sessionKeyOf, type AssistantMessage } from '../protocol/types.js'
import { workspaceLimits, type WorkspaceLimits } from '../protocol/workspace.js'
import { snapshotArtifacts } from '../outcome/envelope.js'
import { kernelHome } from '../kernel/manager.js'
import { captureWorkspace } from '../kernel/workspace.js'
import { abortable } from '../deadline.js'

/** Explicit offline import. Stop ingress/workers and keep their source volumes until verification finishes.
 * Call once for each committed run, and once per routed session on its owning node.
 * Missing files are errors; this never manufactures an empty replacement for a missing old directory.
 */
export async function migrateLocalRuntimeFiles(input: {
  database: SqlPool; objects: RuntimeObjectStore; homesRoot: string; workId: string
  kind: 'artifacts' | 'workspace'; limits?: Partial<WorkspaceLimits>; signal?: AbortSignal
}) {
  const { database, objects } = input, limits = workspaceLimits(input.limits)
  const signal = objectSignal(input.signal, limits.timeoutMs)
  const assertDrained = async () => {
    if ((await database.query("SELECT 1 FROM lingxios.agent_work_items WHERE status='leased' LIMIT 1")).rows.length) {
      throw new Error('file migration requires stopped and drained workers')
    }
  }
  await assertDrained()
  const row = (await database.query('SELECT * FROM lingxios.agent_work_items WHERE id=$1', [input.workId])).rows[0]
  if (!row) throw new Error('migration work is missing')
  const work = workItemFromRow(row, '', 1), key = sessionKeyOf(work), identity = { ...work, runId: work.id }
  const root = await realpath(input.homesRoot)
  const imported: Array<{ path: string; size: number; sha256: string }> = []
  if (input.kind === 'artifacts') {
    const results = await database.query('SELECT message FROM lingxios.agent_results WHERE work_id=$1 ORDER BY committed_at LIMIT 2049', [work.id])
    if (results.rows.length > 2048) throw new Error('migration run exceeds the result limit')
    for (const result of results.rows) for (const artifact of snapshotArtifacts((result['message'] as AssistantMessage).envelope.artifacts)) {
      const { bytes } = await checkedFile(root, artifactDirectory(root, identity), artifact.sha256.toLowerCase(), artifact, signal)
      const objectKey = artifactObjectKey(identity, artifact)
      await abortable(objects.put(objectKey, bytes, signal), signal)
      await readCheckedObject(objects, objectKey, artifact.size, artifact.sha256.toLowerCase(), signal)
      imported.push({ path: artifact.path, size: artifact.size, sha256: artifact.sha256 })
    }
    await assertDrained(); return { artifacts: imported, workspace: null }
  }
  const route = (await database.query('SELECT worker_id,home_epoch FROM lingxios.agent_os_session_routes WHERE session_key=$1', [key])).rows[0]
  if (!route || work.fence < 1) throw new Error('migration session has no prior worker route')
  work.homeEpoch = Number(route['home_epoch'])
  const store = createWorkspaceStore(database, objects, limits), previous = await store.load(work)
  const entries = await captureWorkspace(kernelHome(root, work), previous, limits,
    (path, bytes) => store.stage(work, path, bytes, signal), signal)
  await store.validate(work, { baseGeneration: previous.generation, entries }, signal)
  await withTransaction(database, async client => {
    // A short commit lock fences a concurrent claim; object I/O is already finished.
    await client.query("SET LOCAL lock_timeout='5s'")
    await client.query('LOCK TABLE lingxios.agent_work_items IN SHARE MODE')
    if ((await client.query("SELECT 1 FROM lingxios.agent_work_items WHERE status='leased' LIMIT 1")).rows.length) throw new Error('workers resumed during file migration')
    const currentRoute = (await client.query('SELECT worker_id,home_epoch FROM lingxios.agent_os_session_routes WHERE session_key=$1 FOR UPDATE', [key])).rows[0]
    if (!isDeepStrictEqual(currentRoute, route)) throw new Error('session route changed during file migration')
    const current = (await client.query('SELECT generation,entries FROM lingxios.agent_workspace_checkpoints WHERE session_key=$1 FOR UPDATE', [key])).rows[0]
    if (current) {
      if (Number(current['generation']) !== previous.generation || !isDeepStrictEqual(current['entries'], entries)) throw new Error('existing checkpoint differs from the local migration')
      return
    }
    await client.query(`INSERT INTO lingxios.agent_workspace_checkpoints(session_key,generation,entries,work_id,fence,request_version,step_id)
      VALUES($1,1,$2::jsonb,$3,$4,$5,'offline-import')`,
    [key, JSON.stringify(entries), work.id, work.fence, (row['steer_inputs'] as unknown[]).length + 1])
  })
  return { artifacts: imported, workspace: { generation: previous.generation || 1, entries } }
}
