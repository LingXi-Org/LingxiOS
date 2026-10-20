import { scopedSignal } from '../deadline.js'
import { deadlinePool } from '../control-plane/deadline-pool.js'
import type { SqlClient, SqlPool } from '../control-plane/pg-store.js'

/** Optional lifetime for a public runtime call. Identity and authorization are unchanged. */
export interface RuntimeOperationContext {
  signal?: AbortSignal
  /** Absolute ISO timestamp, shared across calls; never a fresh per-query budget. */
  deadlineAt?: string
}

/** Own one connection for the whole public call, including its existing transaction.
 * PostgreSQL 14+ on supported socket-polling platforms detects a closed client
 * during a blocked query. The server statement deadline also bounds delayed JS
 * timers/network disconnect detection. No cancellation connection is needed. */
export async function withRuntimeOperation<T>(database: SqlPool, operation: RuntimeOperationContext | undefined,
  body: (database: SqlPool) => Promise<T>): Promise<T> {
  if (operation === undefined) return body(database)
  operation.signal?.throwIfAborted()
  const requested = operation.deadlineAt === undefined ? Infinity : Date.parse(operation.deadlineAt)
  if (Number.isNaN(requested)) throw new Error('invalid runtime operation deadline')
  const deadline = Math.min(requested, Date.now() + 30_000)
  const expired = () => new DOMException('Runtime operation deadline exceeded', 'TimeoutError')
  if (deadline <= Date.now()) throw expired()
  const scope = scopedSignal([operation.signal], deadline - Date.now())
  let client: SqlClient | undefined, inFlight = false, borrowed = false
  const check = () => { scope.signal.throwIfAborted(); if (Date.now() >= deadline) throw expired() }
  try {
    client = await deadlinePool(database, scope.signal).connect()
    check()
    const settings = (await client.query("SELECT name,setting FROM pg_settings WHERE name IN ('statement_timeout','client_connection_check_interval')")).rows
    const statementTimeout = settings.find(row => row['name'] === 'statement_timeout')?.['setting']
    const connectionInterval = settings.find(row => row['name'] === 'client_connection_check_interval')?.['setting']
    if (typeof statementTimeout !== 'string' || typeof connectionInterval !== 'string'
      || !Number.isFinite(Number(statementTimeout)) || !Number.isFinite(Number(connectionInterval))) {
      throw new Error('runtime operation cancellation requires PostgreSQL statement and connection-check settings')
    }
    const interval = Number(connectionInterval) > 0 ? Math.min(Number(connectionInterval), 100) : 100
    await client.query("SELECT set_config('client_connection_check_interval',$1,false)", [String(interval)])
    const query: SqlClient['query'] = async (sql, params) => {
      check()
      if (inFlight) throw new Error('runtime operation SQL must be sequential')
      inFlight = true
      try {
        const remaining = Math.max(1, deadline - Date.now())
        const timeout = Number(statementTimeout) > 0 ? Math.min(Number(statementTimeout), remaining) : remaining
        await client!.query("SELECT set_config('statement_timeout',$1,false)", [String(timeout)])
        check()
        const result = await client!.query(sql, params)
        check() // Lost acknowledgement of a committed write is not success.
        return result
      } finally { inFlight = false }
    }
    // Only the runtime's existing sync/ingest transaction borrows this owned
    // connection. Its release does not return the session before settings reset.
    const scoped: SqlPool = { query, async connect() {
      check()
      if (borrowed) throw new Error('runtime operation transaction is already borrowed')
      borrowed = true
      return { query, release() { borrowed = false } }
    } }
    const result = await body(scoped)
    check()
    if (borrowed || inFlight) throw new Error('runtime operation returned with unfinished database work')
    await client.query("SELECT set_config('statement_timeout',$1,false),set_config('client_connection_check_interval',$2,false)",
      [statementTimeout, connectionInterval])
    check()
    return result
  } catch (error) {
    // Never reuse an unfinished transaction or report uncertain writes as absent.
    client?.release(error instanceof Error ? error : new Error('runtime operation failed'))
    throw scope.signal.aborted ? scope.signal.reason : error
  } finally {
    client?.release()
    scope.dispose()
  }
}
