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

/** Only allowlisted metadata crosses the ledger boundary; never messages or response bodies. */
export function modelFailure(error: unknown, cancelled = false): ModelFailure {
  const diagnostics = error instanceof ModelDriverError ? error.diagnostics : undefined
  const status = diagnostics?.status
  let category = diagnostics?.category
  let causeCode: string | undefined
  for (let cause = error, depth = 0; cause && typeof cause === 'object' && depth < 6; depth++) {
    const item = cause as { code?: unknown; name?: unknown; cause?: unknown }
    if (typeof item.code === 'string' && (networkCodes.has(item.code) || timeoutCodes.has(item.code))) causeCode ??= item.code
    if (!category && (item.name === 'TimeoutError' || typeof item.code === 'string' && timeoutCodes.has(item.code))) category = 'timeout'
    cause = item.cause
  }
  if (cancelled) category = 'cancelled'
  category ??= diagnostics?.kind === 'protocol' ? 'protocol'
    : status === 401 || status === 403 ? 'authorization' : status === 402 ? 'quota'
    : status === 429 ? 'rate_limit' : status === 408 ? 'timeout'
    : status !== undefined ? status >= 500 && status !== 501 && status !== 505 ? 'unavailable' : 'unknown'
    : diagnostics && !(error instanceof Error && error.cause) ? 'protocol'
    : causeCode || diagnostics?.kind === 'provider' || diagnostics ? 'network' : 'unknown'
  const requestId = providerRequestId(diagnostics?.requestId), code = providerCode(diagnostics?.providerCode)
  return { category, retryable: ['rate_limit', 'timeout', 'network', 'unavailable'].includes(category)
      || category === 'protocol' && diagnostics?.kind !== 'protocol',
    ...(status !== undefined ? { status } : {}), ...(requestId ? { requestId } : {}), ...(code ? { providerCode: code } : {}),
    ...(causeCode ? { causeCode } : {}),
    ...(diagnostics?.retryAfterMs !== undefined && Number.isFinite(diagnostics.retryAfterMs) && diagnostics.retryAfterMs >= 0
      ? { retryAfterMs: diagnostics.retryAfterMs } : {}) }
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
  if (state.until) state.probing = true
  const current = state
  const generation = current.generation
  return (failure, attempts = 1) => {
    const probe = current.probing
    current.probing = false
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
