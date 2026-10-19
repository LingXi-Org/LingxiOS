/** Explicit operation lifetime: Node 22's AbortSignal.any retains finalization
 * registrations on long-lived sources even after the composed signal is collected. */
export function scopedSignal(sources: readonly (AbortSignal | undefined)[], timeoutMs?: number): {
  signal: AbortSignal; dispose: () => void
} {
  const controller = new AbortController()
  const listeners = new Map<AbortSignal, () => void>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const dispose = () => {
    clearTimeout(timer)
    timer = undefined
    for (const [source, listener] of listeners) source.removeEventListener('abort', listener)
    listeners.clear()
  }
  const abort = (reason: unknown) => { dispose(); controller.abort(reason) }
  for (const source of sources) {
    if (!source || listeners.has(source)) continue
    if (source.aborted) { abort(source.reason); break }
    const listener = () => abort(source.reason)
    listeners.set(source, listener)
    source.addEventListener('abort', listener, { once: true })
  }
  if (timeoutMs !== undefined && !controller.signal.aborted) {
    timer = setTimeout(() => abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), timeoutMs)
    timer.unref()
  }
  return { signal: controller.signal, dispose }
}

/** Bound the caller even when a transport ignores cancellation. */
export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let aborted!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    aborted = () => reject(signal.reason)
    if (signal.aborted) aborted()
    else signal.addEventListener('abort', aborted, { once: true })
  })
  try { return await Promise.race([operation, cancelled]) }
  finally { signal.removeEventListener('abort', aborted) }
}
