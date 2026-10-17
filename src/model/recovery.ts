import { abortable } from '../deadline.js'
import { ModelDriverError, type ModelDiagnostics } from '../errors.js'

export interface ModelRecoveryPolicy {
  /** Attempts include the first outbound request; runtime owns this boundary. */
  maxAttempts: number
  /** Includes provider calls and backoff for one logical request. */
  totalTimeoutMs: number
}
export const DEFAULT_MODEL_RECOVERY: ModelRecoveryPolicy = { maxAttempts: 3, totalTimeoutMs: 120_000 }

export interface ModelFailure {
  category: NonNullable<ModelDiagnostics['category']>
  retryable: boolean
  status?: number
  requestId?: string
  providerCode?: string
  retryAfterMs?: number
  causeCode?: string
}
const networkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET'])
const timeoutCodes = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])
const providerCodes = new Set(['insufficient_quota', 'rate_limit_exceeded', 'invalid_api_key', 'context_length_exceeded',
  'model_not_found', 'billing_hard_limit_reached', 'account_deactivated', 'content_filter'])
export function providerCode(value: unknown): string | undefined {
  return typeof value === 'string' && providerCodes.has(value) ? value : undefined
}
export function providerRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined
}
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const numeric = Number(value)
  const result = Number.isFinite(numeric) ? numeric * 1000 : Date.parse(value) - now
  return Number.isFinite(result) && result >= 0 ? Math.ceil(result) : undefined
}

function field(value: unknown, key: string): unknown {
  try { return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined }
  catch { return undefined }
}
function header(value: unknown, name: string): string | undefined {
  try {
    const result = value instanceof Headers ? value.get(name) : field(value,name)
    return typeof result === 'string' ? result : undefined
  } catch { return undefined }
}

/** Only allowlisted metadata crosses the ledger boundary; never messages or response bodies. */
export function modelFailure(error: unknown, cancelled = false): ModelFailure {
  const diagnostics = error instanceof ModelDriverError ? error.diagnostics : undefined
  const candidateStatus = diagnostics?.status ?? field(error,'status') ?? field(error,'statusCode')
  const status = typeof candidateStatus === 'number' && Number.isInteger(candidateStatus)
    && candidateStatus >= 100 && candidateStatus <= 599 ? candidateStatus : undefined
  const headers = field(error,'headers')
  const code = providerCode(diagnostics?.providerCode ?? field(error,'code') ?? field(field(error,'error'),'code'))
  const requestId = providerRequestId(diagnostics?.requestId ?? field(error,'request_id') ?? field(error,'requestId')
    ?? header(headers,'x-request-id') ?? header(headers,'request-id'))
  const retryAfter = diagnostics?.retryAfterMs ?? retryAfterMs(header(headers,'retry-after') ?? null)
  let category = diagnostics?.category
  let causeCode: string | undefined
  for (let cause = error, depth = 0; cause && typeof cause === 'object' && depth < 6; depth++) {
    const itemCode = field(cause,'code'), name = field(cause,'name')
    if (typeof itemCode === 'string' && (networkCodes.has(itemCode) || timeoutCodes.has(itemCode))) causeCode ??= itemCode
    if (!category && (name === 'TimeoutError' || name === 'APIConnectionTimeoutError'
      || typeof itemCode === 'string' && timeoutCodes.has(itemCode))) category = 'timeout'
    if (!category && name === 'APIConnectionError') category = 'network'
    cause = field(cause,'cause')
  }
  if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached') category = 'quota'
  if (code === 'invalid_api_key' || code === 'account_deactivated') category = 'authorization'
  if (cancelled) category = 'cancelled'
  category ??= diagnostics?.kind === 'protocol' ? 'protocol'
    : status === 401 || status === 403 ? 'authorization' : status === 402 ? 'quota'
    : status === 429 ? 'rate_limit' : status === 408 ? 'timeout'
    : status !== undefined ? status >= 500 && status !== 501 && status !== 505 ? 'unavailable' : 'unknown'
    : diagnostics && !field(error,'cause') ? 'protocol'
    : causeCode || diagnostics?.kind === 'provider' || diagnostics ? 'network' : 'unknown'
  return { category, retryable: ['rate_limit', 'timeout', 'network', 'unavailable'].includes(category)
      || category === 'protocol' && diagnostics?.kind !== 'protocol',
    ...(status !== undefined ? { status } : {}), ...(requestId ? { requestId } : {}), ...(code ? { providerCode: code } : {}),
    ...(causeCode ? { causeCode } : {}),
    ...(retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterMs: retryAfter } : {}) }
}

export function recoveryPolicy(value?: Partial<ModelRecoveryPolicy>): ModelRecoveryPolicy {
  const policy = { ...DEFAULT_MODEL_RECOVERY, ...value }
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 10
    || !Number.isSafeInteger(policy.totalTimeoutMs) || policy.totalTimeoutMs < 1 || policy.totalTimeoutMs > 2_147_483_647) {
    throw new Error('invalid model recovery policy')
  }
  return policy
}

interface CircuitState { failures: number; until: number; probing: boolean; generation: number }
const circuits = new Map<string, CircuitState>()
/** Process-local protection shared by matching provider/model/credential configurations. */
export function acquireCircuit(key: string, resetMs: number): (failure?: ModelFailure, attempts?: number) => void {
  let state = circuits.get(key)
  const now = Date.now()
  if (state && (state.until > now || state.probing)) {
    throw new ModelDriverError('model provider circuit is open', { category: 'circuit_open', finishReasons: [],
      retryAfterMs: Math.max(0, state.until - now), usage: { available: true, inputTokens: 0, outputTokens: 0 } })
  }
  if (!state) {
    // Bound configurations retained by long-lived multi-tenant workers.
    if (circuits.size >= 4096) circuits.delete(circuits.keys().next().value!)
    state = { failures: 0, until: 0, probing: false, generation: 0 }
    circuits.set(key, state)
  }
  const probe = Boolean(state.until)
  if (probe) state.probing = true
  const current = state
  const generation = current.generation
  return (failure, attempts = 1) => {
    if (probe) current.probing = false
    if (!failure) {
      if (current.generation === generation) { current.failures = 0; current.until = 0 }
      return
    }
    if (failure.category === 'cancelled' || failure.category === 'protocol' || failure.category === 'unknown') return
    current.failures += attempts
    current.generation++
    if (probe || failure.category === 'quota' || failure.category === 'authorization' || current.failures >= 3) {
      current.until = Date.now() + Math.max(resetMs, failure.retryAfterMs ?? 0)
    }
  }
}

/** Parse at most 4 KiB for an allowlisted code; never retain or report provider text. */
export async function readProviderErrorCode(response: Response, signal: AbortSignal): Promise<string | undefined> {
  if (!response.body) return undefined
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  const bounded = AbortSignal.any([signal,AbortSignal.timeout(250)])
  let length = 0
  try {
    while (true) {
      const chunk = await abortable(reader.read(),bounded)
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > 4096) return undefined
      chunks.push(chunk.value)
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object') return undefined
    const error = (value as { error?: unknown }).error
    return error && typeof error === 'object' ? providerCode((error as { code?: unknown }).code) : undefined
  } catch { return undefined }
  finally { void reader.cancel().catch(() => {}).finally(() => reader.releaseLock()) }
}
