import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, opendir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { checkedWorkspaceEntries, workspacePath, type WorkspaceEntry, type WorkspaceLimits, type WorkspaceSnapshot } from '../protocol/workspace.js'
import { bytesHash } from '../app/object-store.js'

type FileEntry = Extract<WorkspaceEntry, { kind: 'file' }>
type Observed = { path: string; kind: 'directory' | 'file'; size: number; stamp: string }
const stamp = (value: Awaited<ReturnType<typeof lstat>>) => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs, value.nlink].join(':')

async function inventory(home: string, limits: WorkspaceLimits, signal: AbortSignal): Promise<Observed[]> {
  if (await realpath(home) !== resolve(home)) throw new Error('workspace home must not traverse links')
  const entries: Observed[] = []
  let bytes = 0
  const visit = async (prefix: string) => {
    for await (const item of await opendir(resolve(home, prefix))) {
      signal.throwIfAborted()
      const path = workspacePath(prefix ? `${prefix}/${item.name}` : item.name)
      const info = await lstat(resolve(home, path))
      if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory() || info.isFile() && info.nlink !== 1) throw new Error('workspace contains a link or special file')
      if (info.isFile()) bytes += info.size
      if (entries.length >= limits.maxEntries || bytes > limits.maxBytes || info.isFile() && info.size > limits.maxFileBytes) throw new Error('workspace exceeds checkpoint limits')
      entries.push({ path, kind: info.isDirectory() ? 'directory' : 'file', size: info.size, stamp: stamp(info) })
      if (info.isDirectory()) await visit(path)
    }
  }
  await visit('')
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

async function readFileChecked(home: string, file: Observed, signal: AbortSignal) {
  const handle = await open(resolve(home, file.path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    if (!before.isFile() || stamp(before) !== file.stamp) throw new Error('workspace changed during checkpoint')
    const bytes = Buffer.alloc(file.size)
    let offset = 0
    while (offset < bytes.length) {
      signal.throwIfAborted()
      const result = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset)
      if (!result.bytesRead) throw new Error('workspace changed during checkpoint')
      offset += result.bytesRead
    }
    if (stamp(await handle.stat()) !== file.stamp) throw new Error('workspace changed during checkpoint')
    return bytes
  } finally { await handle.close() }
}

/** Kernel execution is frozen by the caller; a second inventory also detects external filesystem mutation. */
export async function captureWorkspace(home: string, previous: WorkspaceSnapshot, limits: WorkspaceLimits,
  upload: (path: string, bytes: Uint8Array, signal: AbortSignal) => Promise<FileEntry>, signal: AbortSignal): Promise<WorkspaceEntry[]> {
  const before = await inventory(home, limits, signal)
  const prior = new Map(previous.entries.map(entry => [entry.path, entry]))
  const entries: WorkspaceEntry[] = new Array(before.length)
  let cursor = 0
  const run = async () => {
    for (let index = cursor++; index < before.length; index = cursor++) {
      const file = before[index]!
      if (file.kind === 'directory') { entries[index] = { path: file.path, kind: 'directory' }; continue }
      const bytes = await readFileChecked(home, file, signal), sha256 = bytesHash(bytes), old = prior.get(file.path)
      entries[index] = old?.kind === 'file' && old.size === bytes.length && old.sha256 === sha256 ? old : await upload(file.path, bytes, signal)
      const entry = entries[index]!
      if (entry.kind !== 'file' || entry.path !== file.path || entry.size !== bytes.length || entry.sha256 !== sha256) throw new Error('workspace upload receipt mismatch')
    }
  }
  const outcomes = await Promise.allSettled([run(), run()])
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
  if (JSON.stringify(before) !== JSON.stringify(await inventory(home, limits, signal))) throw new Error('workspace changed during checkpoint')
  return checkedWorkspaceEntries(entries, limits)
}

/** Restore into a private sibling, then swap; readers never observe a partial checkpoint. */
export async function restoreWorkspace(home: string, snapshot: WorkspaceSnapshot, limits: WorkspaceLimits,
  read: (entry: FileEntry, signal: AbortSignal) => Promise<Uint8Array>, signal: AbortSignal, discardUncommitted = false): Promise<void> {
  const entries = checkedWorkspaceEntries(snapshot.entries, limits)
  const parent = dirname(home)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  if (await realpath(parent) !== resolve(parent)) throw new Error('workspace parent must not traverse links')
  if (snapshot.generation === 0 && !discardUncommitted) {
    try {
      for await (const _entry of await opendir(home)) throw new Error('existing workspace requires checkpoint migration before recovery')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const temporary = resolve(parent, `.restore-${randomUUID()}`), retired = resolve(parent, `.retired-${randomUUID()}`)
  await mkdir(temporary, { mode: 0o700 })
  let moved = false
  try {
    for (const entry of entries) if (entry.kind === 'directory') await mkdir(resolve(temporary, entry.path), { mode: 0o700 })
    const files = entries.filter((entry): entry is FileEntry => entry.kind === 'file')
    let cursor = 0
    const run = async () => {
      for (let index = cursor++; index < files.length; index = cursor++) {
        signal.throwIfAborted()
        const entry = files[index]!, bytes = await read(entry, signal)
        if (bytes.byteLength !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('workspace restore hash mismatch')
        const handle = await open(resolve(temporary, entry.path), 'wx', 0o600)
        try { await handle.writeFile(bytes, { signal }); await handle.sync() } finally { await handle.close() }
      }
    }
    const outcomes = await Promise.allSettled([run(), run()])
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
    signal.throwIfAborted()
    try {
      const current = await lstat(home)
      if (!current.isDirectory() || current.isSymbolicLink()) throw new Error('unsafe existing workspace')
      await rename(home, retired); moved = true
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    try { await rename(temporary, home) }
    catch (error) { if (moved) { await rename(retired, home); moved = false }; throw error }
  } finally {
    // Both targets are exact random siblings allocated above, never paths supplied by a manifest.
    await rm(temporary, { recursive: true, force: true })
    if (moved) await rm(retired, { recursive: true, force: true })
  }
}
