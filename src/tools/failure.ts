import { randomUUID } from 'node:crypto'

export interface ToolFailureDiagnostics {
  category: 'authorization' | 'not_found' | 'dependency' | 'version' | 'invalid_input' | 'cancelled' | 'unknown'
  /** Eligibility only. The executor separately proves a retry cannot repeat an unknown effect. */
  retryable: boolean
  recovery: 'none' | 'retry' | 'refresh'
  correlationId?: string
  /** Allowlisted machine code only; never a message, resource identity or provider payload. */
  causeCode?: string
}

const denied = new Set(['forbidden', 'unauthorized', 'access_denied', 'permission_denied', 'capability_denied', 'mode_forbidden', 'review_required'])
const blocked = new Set(['dns_blocked', 'blocked_dns', 'dependency_blocked', 'ssrf_blocked', 'EACCES', 'EPERM'])
const version = new Set(['tool_contract_changed', 'approval_stale', 'observation_required', 'version_conflict', 'stale_version'])
const invalid = new Set(['invalid_arguments', 'invalid_input', 'validation_error'])
const cancelled = new Set(['ABORT_ERR', 'tool_cancelled', 'run_cancelled', 'work_cancelled'])
const missing = new Set(['not_found', 'resource_not_found', 'http_404'])
const transient = new Set(['40001', '40P01', '57014', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'dependency_timeout', 'TimeoutError'])
const permanent = new Set(['ENOTFOUND'])
const allowedCauses = new Set([...denied, ...blocked, ...version, ...invalid, ...cancelled, ...missing, ...transient, ...permanent,
  'dependency_unavailable', 'authorization_unavailable', 'http_401', 'http_403', 'http_408', 'http_429', 'http_502', 'http_503', 'http_504', 'AbortError', 'TimeoutError'])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const categories = new Set<ToolFailureDiagnostics['category']>(['authorization', 'not_found', 'dependency', 'version', 'invalid_input', 'cancelled', 'unknown'])

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  try { return (value as Record<string, unknown>)[key] } catch { return undefined }
}

/** Copy only the public allowlist, even when a JavaScript adapter supplies extra fields. */
export function sanitizeToolFailureDiagnostics(value: ToolFailureDiagnostics): ToolFailureDiagnostics {
  const candidate = field(value, 'category') as ToolFailureDiagnostics['category']
  const category = categories.has(candidate) ? candidate : 'unknown'
  const retryable = field(value, 'retryable') === true && category === 'dependency'
  const recovery = category === 'version' ? 'refresh' : retryable ? 'retry' : 'none'
  const correlationId = field(value, 'correlationId'), causeCode = field(value, 'causeCode')
  return Object.freeze({ category, retryable, recovery,
    ...(typeof correlationId === 'string' && uuid.test(correlationId) ? { correlationId } : {}),
    ...(typeof causeCode === 'string' && allowedCauses.has(causeCode) ? { causeCode } : {}) })
}

export interface ToolFailure {
  code: string
  message: string
  diagnostics: ToolFailureDiagnostics
}

/** Classify structured fields only. Terminal causes win over transient wrappers. */
export function classifyToolFailure(error: unknown, phase: 'authorization' | 'input' | 'execution' | 'transaction', signalAborted = false): ToolFailure {
  const codes: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  let prior: ToolFailureDiagnostics | undefined
  for (let depth = 0; depth < 8 && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current)
    const code = field(current, 'code'), status = field(current, 'status') ?? field(current, 'statusCode'), name = field(current, 'name')
    if (typeof code === 'string' && allowedCauses.has(code)) codes.push(code)
    if (typeof status === 'number' && [401,403,404,408,429,502,503,504].includes(status)) codes.push(`http_${status}`)
    if (name === 'AbortError' || name === 'TimeoutError') codes.push(name)
    if (name === 'ForbiddenError') codes.push('forbidden')
    const diagnostics = field(current, 'diagnostics')
    if (diagnostics && typeof diagnostics === 'object') {
      const safe = sanitizeToolFailureDiagnostics(diagnostics as ToolFailureDiagnostics)
      if (!prior) prior = safe
      if (safe.causeCode) codes.push(safe.causeCode)
    }
    current = field(current, 'cause')
  }
  let category: ToolFailureDiagnostics['category'] = 'unknown', retryable = false, code = phase === 'authorization' ? 'authorization_unavailable' : 'native_rejected'
  let causeCode: string | undefined
  const find = (set: ReadonlySet<string>, extra: string[] = []) => codes.find(item => set.has(item) || extra.includes(item))
  if (signalAborted || (causeCode = find(cancelled, ['AbortError']))) { category = 'cancelled'; code = 'tool_cancelled' }
  else if ((causeCode = find(denied, ['http_401', 'http_403'])) || prior?.category === 'authorization') { category = 'authorization'; code = 'forbidden' }
  else if ((causeCode = find(blocked))) { category = 'dependency'; code = 'dependency_blocked' }
  else if ((causeCode = find(missing)) || prior?.category === 'not_found') { category = 'not_found'; code = 'not_found' }
  else if ((causeCode = find(version))) { category = 'version'; code = causeCode }
  else if (phase === 'input' || (causeCode = find(invalid))) { category = 'invalid_input'; code = 'invalid_arguments' }
  else if ((causeCode = find(permanent))) { category = 'dependency'; code = 'dependency_unavailable' }
  else if ((causeCode = find(transient, ['http_408', 'http_429', 'http_502', 'http_503', 'http_504']))) { category = 'dependency'; code = 'dependency_unavailable'; retryable = true }
  else if (prior) { category = prior.category; retryable = prior.retryable; causeCode = prior.causeCode
    code = category === 'dependency' ? 'dependency_unavailable' : category === 'cancelled' ? 'tool_cancelled' : category === 'invalid_input' ? 'invalid_arguments' : code }
  else if (codes.includes('dependency_unavailable')) { category = 'dependency'; code = 'dependency_unavailable'; causeCode = code }
  // Explicit terminal diagnostics must survive repeated classification at transport boundaries.
  if (prior?.category === 'dependency' && !prior.retryable) retryable = false
  if (phase === 'transaction' && category !== 'authorization' && category !== 'not_found' && category !== 'version' && category !== 'invalid_input' && category !== 'cancelled') code = 'transaction_rolled_back'
  const messages: Record<ToolFailureDiagnostics['category'], string> = {
    authorization: 'Native tool authorization denied', not_found: 'Native tool resource is unavailable', dependency: 'Native tool dependency is unavailable',
    version: 'Native tool state changed; refresh authorized state before continuing', invalid_input: 'Native tool arguments are invalid',
    cancelled: 'Native tool operation was cancelled', unknown: phase === 'authorization' ? 'Native authorization was unavailable' : 'Native tool operation failed',
  }
  return { code, message: messages[category], diagnostics: sanitizeToolFailureDiagnostics({ category, retryable,
    recovery: category === 'version' ? 'refresh' : retryable ? 'retry' : 'none', correlationId: prior?.correlationId ?? randomUUID(),
    ...(causeCode ? { causeCode } : {}) }) }
}

/** Only database serialization/deadlock codes establish a safely repeatable rolled-back transaction. */
export function isSerializationFailure(error: unknown): boolean {
  const failure = classifyToolFailure(error, 'transaction')
  return failure.diagnostics.retryable && ['40001', '40P01'].includes(failure.diagnostics.causeCode ?? '')
}
