import { createHash } from 'node:crypto'
import { abortable } from '../deadline.js'

/** Private, immutable runtime bytes. Credentials and provider SDKs stay in the product. */
export interface RuntimeObjectStore {
  put(key: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>
  get(key: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null>
  delete(key: string, signal: AbortSignal): Promise<void>
  list(prefix: string, cursor: string | undefined, limit: number, signal: AbortSignal): Promise<{
    objects: Array<{ key: string; updatedAt: string }>; cursor?: string
  }>
}

export const objectScope = (parts: readonly unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
export const bytesHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export function objectSignal(external?: AbortSignal, timeoutMs = 60_000): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...external ? [external] : []])
}

export async function readCheckedObject(store: RuntimeObjectStore, key: string, size: number, sha256: string, signal: AbortSignal) {
  const bytes = await abortable(store.get(key, size, signal), signal)
  if (!bytes) throw new Error('runtime object is missing')
  if (bytes.byteLength !== size || bytesHash(bytes) !== sha256) throw new Error('runtime object does not match its commitment')
  return bytes
}
