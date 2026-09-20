import { randomUUID } from 'node:crypto'
import { abortable } from '../deadline.js'
import { sessionKeyOf, type WorkItem } from '../protocol/types.js'
import { checkedWorkspaceEntries, workspaceLimits, workspacePath, type WorkspaceCheckpoint, type WorkspaceEntry, type WorkspaceLimits, type WorkspaceSnapshot } from '../protocol/workspace.js'
import type { SqlPool } from '../control-plane/pg-store.js'
import { bytesHash, objectScope, objectSignal, readCheckedObject, type RuntimeObjectStore } from './object-store.js'

type Work = Omit<WorkItem, 'leaseToken'>
export const workspacePrefix = (work: Work) => `workspaces/${objectScope([sessionKeyOf(work)])}/`
export const workspaceUploadPrefix = (work: Work) => `${workspacePrefix(work)}${bytesHash(Buffer.from(work.id))}-${work.fence}/`

export function createWorkspaceStore(database: SqlPool, objects: RuntimeObjectStore, config: Partial<WorkspaceLimits> = {}) {
  const limits = workspaceLimits(config)
  const load = async (work: Work): Promise<WorkspaceSnapshot> => {
    const { rows } = await database.query('SELECT generation,entries FROM lingxios.agent_workspace_checkpoints WHERE session_key=$1', [sessionKeyOf(work)])
    return rows[0] ? { generation: Number(rows[0]['generation']), entries: checkedWorkspaceEntries(rows[0]['entries'], limits) }
      : { generation: 0, entries: [] }
  }
  let cursor: string | undefined
  return {
    limits, load,
    async stage(work: Work, path: string, bytes: Uint8Array, external?: AbortSignal): Promise<Extract<WorkspaceEntry, { kind: 'file' }>> {
      path = workspacePath(path)
      if (bytes.byteLength > limits.maxFileBytes) throw new Error('workspace file limit exceeded')
      const sha256 = bytesHash(bytes), key = `${workspaceUploadPrefix(work)}${randomUUID()}/${sha256}`
      const signal = objectSignal(external, limits.timeoutMs)
      await abortable(objects.put(key, bytes, signal), signal)
      return { kind: 'file', path, size: bytes.byteLength, sha256, objectKey: key }
    },
    async read(work: Work, entry: Extract<WorkspaceEntry, { kind: 'file' }>, external?: AbortSignal) {
      const snapshot = await load(work)
      const match = snapshot.entries.find(candidate => candidate.kind === 'file' && candidate.path === entry.path && candidate.objectKey === entry.objectKey)
      if (!match || match.kind !== 'file' || match.size !== entry.size || match.sha256 !== entry.sha256) throw new Error('workspace file is outside the committed checkpoint')
      return readCheckedObject(objects, match.objectKey, match.size, match.sha256, objectSignal(external, limits.timeoutMs))
    },
    async validate(work: Work, checkpoint: WorkspaceCheckpoint, external?: AbortSignal) {
      if (!Number.isSafeInteger(checkpoint.baseGeneration) || checkpoint.baseGeneration < 0) throw new Error('invalid workspace generation')
      const entries = checkedWorkspaceEntries(checkpoint.entries, limits)
      const previous = await load(work)
      // A retried step save may see its own new generation. The transaction verifies exact step identity.
      if (previous.generation !== checkpoint.baseGeneration && previous.generation !== checkpoint.baseGeneration + 1) throw new Error('workspace checkpoint changed')
      const known = new Map(previous.entries.filter(entry => entry.kind === 'file').map(entry => [entry.objectKey, entry]))
      const signal = objectSignal(external, limits.timeoutMs)
      for (const entry of entries) {
        if (entry.kind !== 'file') continue
        const prior = known.get(entry.objectKey)
        if (prior?.size === entry.size && prior.sha256 === entry.sha256) continue
        if (!entry.objectKey.startsWith(workspaceUploadPrefix(work))) throw new Error('workspace object is outside this attempt')
        await readCheckedObject(objects, entry.objectKey, entry.size, entry.sha256, signal)
      }
      return { baseGeneration: checkpoint.baseGeneration, entries }
    },
    async maintenance(external?: AbortSignal) {
      const signal = objectSignal(external, limits.timeoutMs)
      const page = await abortable(objects.list('workspaces/', cursor, 100, signal), signal)
      cursor = page.cursor
      let removed = 0
      for (const object of page.objects.slice(0, 100)) {
        const match = /^workspaces\/[a-f0-9]{64}\/([a-f0-9]{64})-(\d+)\/[a-f0-9-]{36}\/[a-f0-9]{64}$/.exec(object.key)
        if (!match || !Number.isFinite(Date.parse(object.updatedAt)) || Date.parse(object.updatedAt) > Date.now() - 86_400_000) continue
        const { rows } = await database.query(`SELECT EXISTS(SELECT 1 FROM lingxios.agent_workspace_checkpoints
          WHERE entries @> $1::jsonb) OR EXISTS(SELECT 1 FROM lingxios.agent_work_items
          WHERE encode(sha256(convert_to(id,'UTF8')),'hex')=$2 AND fence=$3 AND status IN ('queued','leased','waiting')) AS retained`,
        [JSON.stringify([{ objectKey: object.key }]), match[1], match[2]])
        // New uploads use a new UUID; a removed object can never be adopted by a later generation.
        if (!rows[0]?.['retained']) { await abortable(objects.delete(object.key, signal), signal); removed++ }
      }
      return { inspected: page.objects.length, removed }
    },
  }
}
