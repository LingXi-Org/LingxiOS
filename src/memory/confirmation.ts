import type { HostActionResult } from '../protocol/types.js'

/** No source names, bodies, paths, model text or request fragments enter this message. */
export const MEMORY_DELETION_CONFIRMATION = 'The memory deletion has been committed. This turn has stopped to avoid reusing forgotten information. Any remaining work is unverified.'

export function isMemoryDeletionReceipt(action: string, result: HostActionResult): boolean {
  if (!result.ok || result.executionState !== 'succeeded' || result.approval) return false
  const value = result.value as Record<string, unknown> | null
  return action === 'memory.forget' && Number.isSafeInteger(value?.['epoch']) && Number(value?.['epoch']) > 0
    || action === 'memory.apply' && Array.isArray(value?.['deleted']) && value['deleted'].length > 0
}
