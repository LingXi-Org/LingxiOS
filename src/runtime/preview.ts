import type { PreviewFrame } from '../protocol/preview.js'
import { setTimeout as delay } from 'node:timers/promises'
import { HostRequestError } from '../host/http-client.js'
import { LeaseLostError, RunCancelledError } from '../errors.js'

/** A bounded draft and coalesced frames; never one promise/HTTP call per token. */
export class PreviewBuffer implements AsyncIterable<PreviewFrame> {
  private pending: PreviewFrame[] = []
  private seq = 0
  private identity = { requestVersion: 1, attemptId: '' }
  private wake: (() => void) | undefined
  private timer: NodeJS.Timeout | undefined
  private closed = false
  private enabled = false
  private first = true
  private draft = ''
  private generation = 0
  private consumer = 0

  get isClosed(): boolean { return this.closed }

  reset(attemptId: string, requestVersion: number, enabled = true): void {
    if (this.closed) return
    this.identity = { attemptId, requestVersion }
    this.enabled = enabled
    this.first = true
    this.draft = ''
    this.generation++
    this.pending = [{ ...this.identity, seq: ++this.seq, kind: 'reset', text: '' }]
    this.flush()
  }

  push(text: string): void {
    if (!this.enabled || this.closed || !text) return
    if (this.draft.length + text.length > 100_000) {
      this.reset(this.identity.attemptId, this.identity.requestVersion, false)
      return
    }
    this.draft += text
    const last = this.pending.at(-1)
    if ((last?.kind === 'delta' ? last.text.length : 0) + text.length > 16_384) {
      this.replay()
      return
    }
    if (last?.kind === 'delta') last.text += text
    else this.pending.push({ ...this.identity, seq: ++this.seq, kind: 'delta', text })
    if (this.first) { this.first = false; this.flush() }
    else this.timer ??= setTimeout(() => this.flush(), 50)
  }

  /** Rebuild only the current authorized attempt, including text produced during reconnect. */
  replay(): void {
    if (this.closed) return
    if (!this.identity.attemptId) { this.flush(); return }
    this.generation++
    this.pending = [{ ...this.identity, seq: ++this.seq, kind: 'reset', text: '' }]
    for (let offset = 0; offset < this.draft.length; offset += 16_384) {
      this.pending.push({ ...this.identity, seq: ++this.seq, kind: 'delta', text: this.draft.slice(offset, offset + 16_384) })
    }
    this.flush()
  }

  recover(): void { this.consumer++; this.replay() }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.wake?.()
    this.wake = undefined
  }

  close(): void { this.closed = true; this.flush() }
  discard(): void { if (this.identity.attemptId) this.reset(this.identity.attemptId, this.identity.requestVersion, false) }

  async *[Symbol.asyncIterator](): AsyncGenerator<PreviewFrame> {
    const consumer = ++this.consumer
    while (true) {
      if (this.timer || !this.pending.length && !this.closed) await new Promise<void>(resolve => { this.wake = resolve })
      if (consumer !== this.consumer) return
      const frames = this.pending.splice(0)
      const generation = this.generation
      for (const frame of frames) {
        if (consumer !== this.consumer) return
        if (generation !== this.generation) break
        yield frame
      }
      if (this.closed && !this.pending.length) return
    }
  }
}

/** Retry the ephemeral channel only; never replay a model call or a revoked draft. */
export async function uploadPreview(buffer: PreviewBuffer, send: (frames: AsyncIterable<PreviewFrame>) => Promise<void>, signal: AbortSignal): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await send(buffer)
      if (buffer.isClosed) return
      throw new Error('preview upload ended before generation')
    }
    catch (error) {
      if (signal.aborted || buffer.isClosed || attempt === 3 || error instanceof LeaseLostError || error instanceof RunCancelledError
        || error instanceof HostRequestError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) throw error
      await delay(100 * 3 ** attempt, undefined, { signal })
      buffer.recover()
    }
  }
}
