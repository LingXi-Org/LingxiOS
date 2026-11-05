import { abortable } from '../deadline.js'
import { ConfigError } from '../errors.js'
import type { SqlClient, SqlPool } from '../control-plane/pg-store.js'

export interface BackgroundOptions {
  /** Active owns durable delivery and maintenance. Passive exposes APIs without starting background work or LISTEN. */
  role?: 'active' | 'passive'
  /** Maximum concurrent background database connections; excludes API calls and the one dedicated LISTEN connection. */
  databaseConcurrency?: number
  /** Busy scans and the first idle scan use this delay. Defaults to 1 second. */
  minPollMs?: number
  /** Empty/error scans back off up to this delay. Defaults to 30 seconds. */
  maxPollMs?: number
  /** Storage, workspace and metrics sweep interval. Defaults to 60 seconds. */
  sweepIntervalMs?: number
}

export function backgroundOptions(options: BackgroundOptions = {}) {
  const config = { role: options.role ?? 'active', databaseConcurrency: options.databaseConcurrency ?? 2,
    minPollMs: options.minPollMs ?? 1000, maxPollMs: options.maxPollMs ?? 30_000,
    sweepIntervalMs: options.sweepIntervalMs ?? 60_000 }
  if (!['active', 'passive'].includes(config.role)
    || !Number.isSafeInteger(config.databaseConcurrency) || config.databaseConcurrency < 1 || config.databaseConcurrency > 32
    || !Number.isSafeInteger(config.minPollMs) || config.minPollMs < 1 || config.minPollMs > 60_000
    || !Number.isSafeInteger(config.maxPollMs) || config.maxPollMs < config.minPollMs || config.maxPollMs > 300_000
    || !Number.isSafeInteger(config.sweepIntervalMs) || config.sweepIntervalMs < 1 || config.sweepIntervalMs > 3_600_000) {
    throw new ConfigError('invalid background role, database concurrency or polling limits')
  }
  return config
}

interface Job {
  operation: (signal: AbortSignal) => Promise<boolean | void>
  concurrency: number
  minimum: number
  maximum: number
  delay: number
  active: Set<Promise<void>>
  dirty: boolean
  queued: boolean
  timer?: ReturnType<typeof setTimeout>
}

/** Fixed, named jobs with bounded overlap and one coalesced wakeup per job. No work executes after stop. */
export class BackgroundScheduler {
  readonly signal: AbortSignal
  private readonly cancel = new AbortController()
  private readonly jobs = new Map<string, Job>()
  private stopped = false
  private stopping: Promise<void> | undefined
  private readonly onAbort = () => { void this.stop() }

  constructor(private readonly options: { signal: AbortSignal; minPollMs: number; maxPollMs: number;
    onError?: (name: string, error: unknown) => void }) {
    this.signal = AbortSignal.any([options.signal, this.cancel.signal])
    if (options.signal.aborted) this.stopped = true
    else options.signal.addEventListener('abort', this.onAbort, { once: true })
  }

  add(name: string, operation: Job['operation'], options: { concurrency?: number; intervalMs?: number } = {}): void {
    if (this.jobs.has(name)) throw new Error(`duplicate background job: ${name}`)
    const concurrency = options.concurrency ?? 1
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('invalid background job concurrency')
    const minimum = options.intervalMs ?? this.options.minPollMs, maximum = options.intervalMs ?? this.options.maxPollMs
    const job: Job = { operation, concurrency, minimum, maximum, delay: minimum, active: new Set(), dirty: false, queued: false }
    this.jobs.set(name, job)
    this.schedule(name, job, minimum)
  }

  wake(name: string): void {
    if (this.stopped) return
    const job = this.jobs.get(name)
    if (!job) return
    job.dirty = true
    if (job.timer) { clearTimeout(job.timer); delete job.timer }
    this.enqueue(name, job)
  }

  private enqueue(name: string, job: Job): void {
    if (this.stopped || job.queued || job.active.size >= job.concurrency) return
    job.queued = true
    queueMicrotask(() => { job.queued = false; this.run(name, job) })
  }

  private schedule(name: string, job: Job, delay: number): void {
    if (this.stopped || job.timer) return
    job.timer = setTimeout(() => { delete job.timer; this.run(name, job) }, delay)
    job.timer.unref()
  }

  private run(name: string, job: Job): void {
    if (this.stopped || job.active.size >= job.concurrency) return
    job.dirty = false
    const running = Promise.resolve().then(async () => {
      this.signal.throwIfAborted()
      const busy = await abortable(job.operation(this.signal), this.signal)
      job.delay = busy ? job.minimum : Math.min(job.maximum, job.delay * 2)
    }).catch(error => {
      job.delay = Math.min(job.maximum, job.delay * 2)
      if (!this.signal.aborted) this.options.onError?.(name, new Error('Background operation failed'))
    }).finally(() => {
      job.active.delete(running)
      if (this.stopped) return
      if (!job.active.size && job.timer) { clearTimeout(job.timer); delete job.timer }
      if (job.dirty) this.enqueue(name, job)
      else this.schedule(name, job, job.active.size ? job.minimum : job.delay)
    })
    job.active.add(running)
    // A slow delivery leaves its other lanes available on subsequent scans.
    if (job.active.size < job.concurrency) this.schedule(name, job, job.minimum)
  }

  get pending(): number {
    return [...this.jobs.values()].reduce((count, job) => count + job.active.size + Number(!!job.timer) + Number(job.queued), 0)
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopped = true
    this.options.signal.removeEventListener('abort', this.onAbort)
    this.cancel.abort(new Error('background scheduler stopped'))
    for (const job of this.jobs.values()) {
      if (job.timer) clearTimeout(job.timer)
      delete job.timer
      job.dirty = false
      job.queued = false
    }
    this.stopping = Promise.allSettled([...this.jobs.values()].flatMap(job => [...job.active])).then(() => {})
    return this.stopping
  }
}

/** A background-only FIFO connection budget. Permits cover transactions, never external transport waits. */
export function backgroundPool(pool: SqlPool, concurrency: number, signal: AbortSignal): SqlPool {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new ConfigError('invalid background database concurrency')
  type Waiter = { ready: () => void; cancel: () => void }
  const waiting: Waiter[] = []
  let active = 0
  const acquire = async () => {
    signal.throwIfAborted()
    if (active < concurrency) { active++; return }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { ready: () => { signal.removeEventListener('abort', waiter.cancel); resolve() }, cancel: () => {
        const index = waiting.indexOf(waiter)
        if (index >= 0) waiting.splice(index, 1)
        signal.removeEventListener('abort', waiter.cancel)
        reject(signal.reason)
      } }
      waiting.push(waiter)
      signal.addEventListener('abort', waiter.cancel, { once: true })
      if (signal.aborted) waiter.cancel()
    })
  }
  const permit = () => {
    const next = waiting.shift()
    if (next) next.ready()
    else active--
  }
  return {
    async connect(): Promise<SqlClient> {
      await acquire()
      let client: SqlClient
      try {
        signal.throwIfAborted()
        const pending = pool.connect()
        try { client = await abortable(pending, signal) }
        catch (error) {
          void pending.then(late => late.release(error instanceof Error ? error : new Error('background acquisition cancelled')), () => {})
          throw error
        }
      } catch (error) { permit(); throw error }
      let released = false
      const release = (error?: Error) => {
        if (released) return
        released = true
        signal.removeEventListener('abort', cancel)
        try { client.release(error) } finally { permit() }
      }
      const cancel = () => release(signal.reason instanceof Error ? signal.reason : new Error('background stopped'))
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
      return { async query(sql, params) {
        signal.throwIfAborted()
        if (released) throw new Error('background database connection is closed')
        return abortable(client.query(sql, params), signal)
      }, release }
    },
    async query(sql, params) {
      const client = await this.connect()
      try { return await client.query(sql, params) } finally { client.release() }
    },
  }
}
