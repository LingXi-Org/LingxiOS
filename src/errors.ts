/**
 * Error taxonomy of the Agent OS. Every error a layer can surface across a
 * boundary is a named class here, so callers branch on `instanceof` instead
 * of message text.
 */

/** Base class: all Agent OS errors carry a stable machine-readable code. */
export class AgentOSError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

export type BudgetDimension = 'calls' | 'tokens' | 'cost' | 'deadline' | 'reservation'
export class ModelBudgetExceededError extends AgentOSError {
  readonly diagnostics: { code: 'budget_limit'; dimension: BudgetDimension }
  constructor(message: string, dimension: BudgetDimension = 'reservation') {
    super('budget_limit', message)
    this.diagnostics = Object.freeze({ code: 'budget_limit', dimension })
  }
}

export class ModelContextBudgetError extends AgentOSError {
  constructor() { super('model_context_budget', 'model call exceeds its context budget; original input was not truncated') }
}

// Lease / work lifecycle ----------------------------------------------------

/** The control plane no longer recognizes this (id, fence, token) lease. */
export class LeaseLostError extends AgentOSError {
  constructor(message = 'work lease lost or expired') {
    super('lease_lost', message)
  }
}

/** The run was cancelled (by a human, by preemption, or by shutdown). */
export class RunCancelledError extends AgentOSError {
  constructor(readonly scope: string, message = `run cancelled (${scope})`) {
    super('run_cancelled', message)
  }
}

// Kernel --------------------------------------------------------------------

/** The cell raised: model-visible, recoverable via a correction turn. */
export class KernelExecutionError extends AgentOSError {
  constructor(message: string, readonly cellId: string) {
    super('kernel_execution_failed', message)
  }
}

/** The cell exceeded its wall-clock budget; the kernel was killed. */
export class KernelTimeoutError extends AgentOSError {
  constructor(readonly timeoutMs: number, readonly cellId: string) {
    super('kernel_timeout', `kernel cell exceeded ${timeoutMs}ms and was terminated`)
  }
}

/** The cell was aborted before completion. */
export class KernelCancelledError extends AgentOSError {
  constructor(readonly cellId: string) {
    super('kernel_cancelled', 'kernel cell cancelled')
  }
}

/** The kernel process died or spoke an invalid protocol. */
export class KernelProtocolError extends AgentOSError {
  constructor(message: string) {
    super('kernel_protocol', message)
  }
}

// Host bridge ---------------------------------------------------------------

/** A host action suspended into a human approval; the run must park. */
export class ApprovalPendingError extends AgentOSError {
  constructor(readonly approvalId: string, readonly cellId: string) {
    super('approval_pending', `approval pending: ${approvalId}`)
  }
}

// Model ---------------------------------------------------------------------

/** Closed structural reasons only; never rejected keys, values or provider text. */
export const MODEL_PROTOCOL_DETAILS = ['json_syntax', 'duplicate_field', 'unknown_field', 'answer_type', 'commentary_type',
  'operation_invalid', 'outcome_invalid', 'root_invalid', 'unicode_invalid', 'text_regression', 'depth_limit', 'size_limit',
  'parser_closed', 'identity_changed', 'tool_name_unknown', 'tool_id_invalid', 'tool_id_duplicate', 'tool_index_invalid',
  'tool_batch_invalid', 'tool_metadata_invalid', 'mixed_output_channels', 'terminal_with_business',
  'public_answer_missing', 'public_answer_misordered'] as const
export type ModelProtocolDetail = typeof MODEL_PROTOCOL_DETAILS[number]

export interface ModelDiagnostics {
  /** Provider usage remains billable when its completed response violates the protocol. */
  usage?: import('./model/driver.js').ModelUsage
  kind?: 'provider' | 'protocol'
  /** Fixed contract failures only; never provider response text. */
  protocolCode?: 'native_envelope_invalid' | 'terminal_outcome_required' | 'public_text_invalid' | 'public_text_incomplete' | 'public_text_answer_required' | 'public_answer_first_required' | 'tool_identity_invalid' | 'response_empty'
  protocolDetail?: ModelProtocolDetail
  status?: number
  finishReasons: string[]
  requestId?: string
  attempts?: number
  retryAfterMs?: number
  providerCode?: string
  category?: 'authorization' | 'quota' | 'rate_limit' | 'timeout' | 'network' | 'unavailable' | 'protocol' | 'cancelled' | 'circuit_open' | 'unknown'
}

/** The model provider failed or returned a protocol-violating response. */
export class ModelDriverError extends AgentOSError {
  constructor(message: string, readonly diagnostics: ModelDiagnostics, options?: ErrorOptions) {
    super('model_driver', message, options)
  }
}

// Configuration -------------------------------------------------------------

export class ConfigError extends AgentOSError {
  constructor(message: string) {
    super('config', message)
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
