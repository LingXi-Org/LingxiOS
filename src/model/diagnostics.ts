import { providerCode } from './recovery.js'

const kinds = new Set(['provider', 'protocol'])
const categories = new Set(['authorization', 'quota', 'rate_limit', 'timeout', 'network', 'unavailable',
  'protocol', 'cancelled', 'circuit_open', 'unknown'])
const finishReasons = new Set(['stop', 'length', 'tool_calls', 'function_call', 'content_filter', 'missing', 'unknown'])

function field(value: unknown, key: string): unknown {
  try { return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined }
  catch { return undefined }
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
}

/**
 * Fresh event/log projection, not the driver error or recovery ledger. Diagnostic
 * objects may contain provider text at any depth, including nominal string enums.
 * Correlation IDs and arbitrary extension fields stay out of this public copy.
 */
export function publicModelDiagnostics(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, allowed] of [['kind', kinds], ['category', categories]] as const) {
    const candidate = field(value, key)
    if (typeof candidate === 'string' && allowed.has(candidate)) out[key] = candidate
  }
  const status = field(value, 'status')
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) out['status'] = status
  const reasons = field(value, 'finishReasons')
  if (Array.isArray(reasons)) out['finishReasons'] = reasons.slice(0, 32)
    .map(reason => typeof reason === 'string' && finishReasons.has(reason) ? reason : 'unknown')
  const code = providerCode(field(value, 'providerCode'))
  if (code) out['providerCode'] = code
  for (const key of ['attempts', 'retryAfterMs', 'providerDurationMs', 'providerFirstContentMs']) {
    const candidate = field(value, key)
    if (finiteNonnegative(candidate) && (key !== 'attempts' || Number.isSafeInteger(candidate))) out[key] = candidate
  }
  const usage = field(value, 'usage'), available = field(usage, 'available')
  const input = field(usage, 'inputTokens'), output = field(usage, 'outputTokens')
  if (typeof available === 'boolean' && finiteNonnegative(input) && Number.isSafeInteger(input)
    && finiteNonnegative(output) && Number.isSafeInteger(output)) {
    const safe: Record<string, unknown> = { available, inputTokens: input, outputTokens: output }
    for (const key of ['cachedInputTokens', 'reasoningTokens']) {
      const candidate = field(usage, key)
      if (finiteNonnegative(candidate) && Number.isSafeInteger(candidate)) safe[key] = candidate
    }
    out['usage'] = safe
  }
  return out
}
