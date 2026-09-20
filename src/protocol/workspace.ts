/** A checkpoint describes only sandbox files, never interpreter state or credentials. */
export type WorkspaceEntry = { path: string; kind: 'directory' }
  | { path: string; kind: 'file'; size: number; sha256: string; objectKey: string }
export interface WorkspaceSnapshot { generation: number; entries: WorkspaceEntry[] }
export interface WorkspaceState { snapshot: WorkspaceSnapshot; limits: WorkspaceLimits }
export interface WorkspaceCheckpoint { baseGeneration: number; entries: WorkspaceEntry[] }
export interface WorkspaceLimits { maxEntries: number; maxBytes: number; maxFileBytes: number; timeoutMs: number }
export const DEFAULT_WORKSPACE_LIMITS: Readonly<WorkspaceLimits> = Object.freeze({
  maxEntries: 4096, maxBytes: 128 * 1024 * 1024, maxFileBytes: 32 * 1024 * 1024, timeoutMs: 60_000,
})

export function workspaceLimits(options: Partial<WorkspaceLimits> = {}): WorkspaceLimits {
  const limits = { ...DEFAULT_WORKSPACE_LIMITS, ...options }
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid workspace limit')
  if (limits.maxEntries > 4096 || limits.maxFileBytes > 64 * 1024 * 1024 || limits.maxBytes > 1024 * 1024 * 1024
    || limits.maxFileBytes > limits.maxBytes || limits.timeoutMs > 300_000) throw new Error('workspace limits exceed the transport budget')
  return limits
}

export function workspacePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\\u0000-\u001f\u007f:]/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('invalid workspace path')
  return value
}

export function checkedWorkspaceEntries(value: unknown, limits: WorkspaceLimits): WorkspaceEntry[] {
  if (!Array.isArray(value) || value.length > limits.maxEntries) throw new Error('workspace entry limit exceeded')
  let total = 0
  const seen = new Map<string, string>()
  const entries: WorkspaceEntry[] = value.map((entry: WorkspaceEntry) => {
    if (!entry || typeof entry !== 'object') throw new Error('invalid workspace entry')
    const path = workspacePath(entry.path)
    // Case-folding keeps a Linux checkpoint safe to restore on a case-insensitive development volume.
    if (seen.has(path.toLowerCase())) throw new Error('duplicate workspace path')
    seen.set(path.toLowerCase(), entry.kind)
    if (entry.kind === 'directory') return { kind: 'directory', path }
    if (entry.kind !== 'file' || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limits.maxFileBytes
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || typeof entry.objectKey !== 'string' || !/^workspaces\/[a-f0-9]{64}\/[a-f0-9]{64}-\d+\/[a-f0-9-]{36}\/[a-f0-9]{64}$/.test(entry.objectKey)) throw new Error('invalid workspace file')
    total += entry.size
    if (total > limits.maxBytes) throw new Error('workspace byte limit exceeded')
    return { kind: 'file', path, size: entry.size, sha256: entry.sha256, objectKey: entry.objectKey }
  })
  for (const entry of entries) {
    const parts = entry.path.split('/')
    for (let length = 1; length < parts.length; length++) {
      if (seen.get(parts.slice(0, length).join('/').toLowerCase()) !== 'directory') throw new Error('workspace parent directory is missing')
    }
  }
  return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}
