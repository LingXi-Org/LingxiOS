import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { classifyToolFailure, sanitizeToolFailureDiagnostics, type ToolFailureDiagnostics } from '../tools/failure.js'
import { releaseVersions } from '../versions.js'
import { PublicTextPublicationError, readPublicationFailure, type PublicationFailure } from './public-text.js'

const phases = ['recovery', 'run_start', 'processor', 'context_load', 'model_selection', 'input_loaded',
  'execution_snapshot', 'session_restore', 'request_refresh', 'binding_prepare', 'binding_save', 'session_save', 'turn_execution'] as const
const bindingStates = ['unknown', 'not_started', 'saving', 'saved', 'restored'] as const
export type RuntimeFailurePhase = typeof phases[number]
export type RuntimeBindingState = typeof bindingStates[number]
const errorNames = ['UnknownError', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError',
  'AggregateError', 'AbortError', 'TimeoutError', 'DOMException', 'DatabaseError', 'NoEffectError', 'ForbiddenError', 'HttpError',
  'AgentOSError', 'HostRequestError', 'ControlPlaneError', 'ModelDriverError', 'ModelBudgetExceededError', 'ModelContextBudgetError',
  'HardLimitExceededError', 'LeaseLostError', 'RunCancelledError', 'ConfigError'] as const
const reasons = ['native_rejected', 'tool_cancelled', 'forbidden', 'dependency_blocked', 'not_found', 'budget_limit',
  'tool_contract_changed', 'approval_stale', 'observation_required', 'version_conflict', 'stale_version', 'invalid_arguments',
  'dependency_unavailable'] as const
const systemCodes = ['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EROFS', 'EISDIR', 'ENOTDIR', 'ELOOP', 'EMFILE', 'ENFILE'] as const
const sqlClasses = new Set(['00', '01', '02', '03', '08', '09', '0A', '0B', '0F', '0L', '0P', '0Z', '20', '21', '22',
  '23', '24', '25', '26', '27', '28', '2B', '2D', '2F', '34', '38', '39', '3B', '3D', '3F', '40', '42', '44', '53',
  '54', '55', '57', '58', '72', 'F0', 'HV', 'P0', 'XX'])
// Fixed native sources only. Never derive a module name from an arbitrary
// basename, function name, absolute directory or product-supplied stack text.
const nativeModules = new Set(['runtime/runtime', 'runtime/execution-policy', 'runtime/policy', 'runtime/tool-batch',
  'runtime/compaction', 'runtime/corrections', 'runtime/answer-segments', 'runtime/answer-correction', 'runtime/public-text',
  'context/request', 'context/request-history', 'context/compiler', 'context/evidence', 'context/attachments',
  'prompts/provider', 'outcome/verification', 'outcome/obligations', 'tools/catalog', 'tools/contracts',
  'host/http-client', 'host/deadline-host', 'host/checkpoint-host', 'control-plane/service', 'control-plane/steps',
  'control-plane/pg-store', 'model/execution', 'model/openai', 'memory/context', 'memory/semantic', 'memory/runtime',
  'memory/service', 'memory/store', 'deadline', 'app/index'].flatMap(module => [`${module}.ts`, `${module}.js`]))
const sourceUrl = new URL('../', import.meta.url)
const sourceRoots = [fileURLToPath(sourceUrl),
  // tsx/Node source maps can name package/src while this module is loaded from
  // package/dist/src. Both roots come only from this module's own location.
  ...(sourceUrl.pathname.endsWith('/dist/src/') ? [fileURLToPath(new URL('../../src/', sourceUrl))] : [])]
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const deployment = /^(?:unknown|[a-f0-9]{40}|[a-f0-9]{64})$/i
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const includes = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && values.includes(value as T)
const sqlState = (value: unknown): value is string => typeof value === 'string' && /^[0-9A-Z]{5}$/.test(value) && sqlClasses.has(value.slice(0, 2))

export interface RuntimeFailureFrame { module: string; line: number; column?: number }
/** Internal operator metadata, never user-visible failure text or original exception data. */
export interface RuntimeFailureDiagnostic {
  schemaVersion: 1
  correlationId: string
  runId: string
  requestVersion: number
  fence: number
  runtimeVersion: string
  deploymentVersion?: string
  phase: RuntimeFailurePhase
  bindingState: RuntimeBindingState
  errorName: typeof errorNames[number]
  reason: typeof reasons[number]
  category: ToolFailureDiagnostics['category']
  retryable: boolean
  causeCode?: string
  sqlState?: string
  systemCode?: typeof systemCodes[number]
  httpStatus?: number
  frames: RuntimeFailureFrame[]
  publicationFailure?: PublicationFailure
  continuationReason?: 'intermediate_outcome_null'
}
export interface RuntimeFailureLocation { phase: RuntimeFailurePhase; bindingState: RuntimeBindingState; requestVersion: number; continuationReason?: 'intermediate_outcome_null' }

export function validateDeploymentVersion(value: string | undefined): string | undefined {
  if (value !== undefined && (typeof value !== 'string' || !deployment.test(value)))
    throw new Error('deploymentVersion must be unknown or a full Git commit SHA')
  return value?.toLowerCase()
}
function field(value: unknown, key: string): unknown {
  try { return value && typeof value === 'object' ? Reflect.get(value, key) : undefined } catch { return undefined }
}
function frames(error: unknown): RuntimeFailureFrame[] {
  const stack = field(error, 'stack'), result: RuntimeFailureFrame[] = []
  if (typeof stack !== 'string') return result
  for (const text of stack.slice(0, 16_384).split('\n').slice(0, 64)) {
    const match = /^\s*at (?:[^()\r\n]* \()?((?:file:\/\/\/|\/|[A-Za-z]:[\\/])[^()\r\n]*?):(\d+)(?::(\d+))?\)?$/.exec(text)
    if (!match) continue
    let source = match[1]!
    if (source.startsWith('file:')) {
      try { const url = new URL(source); if (url.search || url.hash) continue; source = fileURLToPath(url) } catch { continue }
    }
    const sourceRoot = sourceRoots.find(root => source.startsWith(root))
    if (!sourceRoot) continue
    const module = source.slice(sourceRoot.length).replaceAll('\\', '/'), line = Number(match[2]), column = match[3] === undefined ? undefined : Number(match[3])
    if (!nativeModules.has(module) || !positive(line) || column !== undefined && !positive(column)) continue
    result.push({ module, line, ...(column === undefined ? {} : { column }) })
    if (result.length === 4) break
  }
  return result
}

export function projectRuntimeFailure(error: unknown, identity: { runId: string; fence: number },
  location: RuntimeFailureLocation, deploymentVersion?: string): RuntimeFailureDiagnostic {
  const failure = classifyToolFailure(error, 'execution'), name = field(error, 'name')
  let sql: string | undefined, system: RuntimeFailureDiagnostic['systemCode'], http: number | undefined
  let publicationFailure: PublicationFailure | undefined
  const seen = new Set<unknown>()
  for (let current = error, depth = 0; current && depth < 8 && !seen.has(current); depth++) {
    seen.add(current)
    if(current instanceof PublicTextPublicationError)publicationFailure??=readPublicationFailure({stage:current.stage,code:current.rejection})
    const code = field(current, 'code'), status = field(current, 'status') ?? field(current, 'statusCode')
    if (sqlState(code)) sql ??= code
    if (includes(systemCodes, code)) system ??= code
    if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) http ??= status
    current = field(current, 'cause')
  }
  return { schemaVersion: 1, correlationId: failure.diagnostics.correlationId ?? randomUUID(), ...identity, ...location,
    runtimeVersion: releaseVersions.runtime, ...(deploymentVersion === undefined ? {} : { deploymentVersion }),
    errorName: includes(errorNames, name) ? name : 'UnknownError',
    reason: includes(reasons, failure.code) ? failure.code : 'native_rejected', category: failure.diagnostics.category,
    retryable: failure.diagnostics.retryable, ...(failure.diagnostics.causeCode ? { causeCode: failure.diagnostics.causeCode } : {}),
    ...(sql ? { sqlState: sql } : {}), ...(system ? { systemCode: system } : {}), ...(http === undefined ? {} : { httpStatus: http }),
    ...(publicationFailure?{publicationFailure}:{}),frames: frames(error) }
}

/** Revalidate persisted/worker-supplied data before it crosses the operator API. */
export function readRuntimeFailureDiagnostic(input: unknown): RuntimeFailureDiagnostic | null {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null
    const value = input as RuntimeFailureDiagnostic
    const keys = ['schemaVersion', 'correlationId', 'runId', 'requestVersion', 'fence', 'runtimeVersion', 'deploymentVersion', 'phase',
      'bindingState', 'errorName', 'reason', 'category', 'retryable', 'causeCode', 'sqlState', 'systemCode', 'httpStatus', 'frames', 'publicationFailure', 'continuationReason']
    if (Object.keys(value).some(key => !keys.includes(key)) || value.schemaVersion !== 1
      || typeof value.correlationId !== 'string' || !uuid.test(value.correlationId)
      || typeof value.runId !== 'string' || !value.runId || value.runId.length > 200
      || !positive(value.requestVersion) || !positive(value.fence)
      || typeof value.runtimeVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.runtimeVersion) || value.runtimeVersion.length > 64
      || !includes(phases, value.phase) || !includes(bindingStates, value.bindingState)
      || !includes(errorNames, value.errorName) || !includes(reasons, value.reason)
      || typeof value.retryable !== 'boolean') return null
    const classification = sanitizeToolFailureDiagnostics({ ...value, recovery: 'none' })
    if (classification.category !== value.category || classification.retryable !== value.retryable
      || classification.causeCode !== value.causeCode) return null
    if (value.deploymentVersion !== undefined && (typeof value.deploymentVersion !== 'string' || !deployment.test(value.deploymentVersion))) return null
    if (value.sqlState !== undefined && !sqlState(value.sqlState)) return null
    if (value.systemCode !== undefined && !includes(systemCodes, value.systemCode)) return null
    if (value.httpStatus !== undefined && (typeof value.httpStatus !== 'number' || !Number.isInteger(value.httpStatus) || value.httpStatus < 400 || value.httpStatus > 599)) return null
    if (value.publicationFailure !== undefined && !readPublicationFailure(value.publicationFailure)) return null
    if (value.continuationReason !== undefined && value.continuationReason !== 'intermediate_outcome_null') return null
    if (!Array.isArray(value.frames) || value.frames.length > 4 || value.frames.some(frame => !frame || typeof frame !== 'object'
      || Object.keys(frame).some(key => !['module', 'line', 'column'].includes(key)) || !nativeModules.has(frame.module)
      || !positive(frame.line) || frame.column !== undefined && !positive(frame.column))) return null
    // Copy validated primitives only; never return the persisted input object.
    return { schemaVersion: 1, correlationId: value.correlationId, runId: value.runId, requestVersion: value.requestVersion,
      fence: value.fence, runtimeVersion: value.runtimeVersion, phase: value.phase, bindingState: value.bindingState,
      errorName: value.errorName, reason: value.reason, category: value.category, retryable: value.retryable,
      ...(value.deploymentVersion === undefined ? {} : { deploymentVersion: value.deploymentVersion }),
      ...(value.causeCode === undefined ? {} : { causeCode: value.causeCode }), ...(value.sqlState === undefined ? {} : { sqlState: value.sqlState }),
      ...(value.systemCode === undefined ? {} : { systemCode: value.systemCode }), ...(value.httpStatus === undefined ? {} : { httpStatus: value.httpStatus }),
      ...(value.publicationFailure === undefined ? {} : { publicationFailure: readPublicationFailure(value.publicationFailure)! }),
      ...(value.continuationReason === undefined ? {} : { continuationReason: value.continuationReason }),
      frames: value.frames.map(frame => ({ module: frame.module, line: frame.line, ...(frame.column === undefined ? {} : { column: frame.column }) })) }
  } catch { return null }
}
