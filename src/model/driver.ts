import type { OutcomeDeclaration, PublicTextProtocol } from './outcome-declaration.js'
export type { OutcomeDeclaration, PublicTextProtocol } from './outcome-declaration.js'
import type { PublicTextPurpose } from '../protocol/public-text.js'
import type { PublicTextOperation } from '../protocol/answer-segments.js'
/**
 * Model driver port. The runtime speaks only this interface; concrete
 * providers (OpenAI-compatible, Anthropic, test fakes) live behind it.
 */
import type { CodeExecutionMode, ModelItem } from '../protocol/types.js'
import type { ModelProfile, ModelPurpose } from './profile.js'

export interface ModelUsage {
  available: boolean
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  reasoningTokens?: number
}

export interface ModelTurnResult {
  callId?: string
  /** Optional explicit structured self-assessment from a driver; plain answers use text. */
  finalCandidate?: string
  /** Explicit purpose-json-v2 final declaration; not an independent verification. */
  outcomeDeclaration?: OutcomeDeclaration
  answerOperation?: PublicTextOperation
  answerIsNull?: boolean
  /** A complete public message; execution continues until an explicit terminal declaration. */
  publicTextPhase?: 'intermediate'
  /** Items to append to session history (assistant text and/or tool calls). */
  output: ModelItem[]
  /** Full assistant text of this turn ('' when the turn is a tool call). */
  text: string
  model?: string
  usage: ModelUsage
  diagnostics?: Record<string, unknown>
}

export interface ModelTurnRequest {
  /** Runtime-owned diagnostic classification; never provider instructions. */
  operation?: 'generation' | 'correction'
  /** Runtime-owned final gate; queue wrappers run it after obtaining capacity. */
  beforeProvider?: (() => void | Promise<void>) | undefined
  admission?: import('../resource-quota.js').ResourcePriority
  purpose?: Extract<ModelPurpose, 'execute' | 'approval-explanation'>
  tools?: readonly import('../tools/catalog.js').ToolDefinition[]
  /** Whether the built-in Python tool is structurally available for this turn. */
  codeExecution?: CodeExecutionMode
  instructions: string
  /** Local diagnostics, never sent as provider request fields. */
  prompt?: import('../context/compiler.js').PromptManifest
  items: readonly ModelItem[]
  signal?: AbortSignal | undefined
  /** Decoded public text; purpose metadata is required when publicTextProtocol is declared. */
  onTextDelta?: (((delta: string, metadata?: { purpose: PublicTextPurpose }) => void) | ((delta: string, metadata?: { purpose: PublicTextPurpose }) => Promise<void>)) | undefined
  /** Runtime-owned retry boundary; clears any draft from the preceding provider attempt. */
  onAttempt?: (((callId: string) => void) | ((callId: string) => Promise<void>)) | undefined
  /** v3 operation is validated before any public answer delta. */
  onTextOperation?: ((operation: PublicTextOperation) => void | Promise<void>) | undefined
  /** Server-owned active source IDs; null terminal answers still require full runtime validation. */
  answerContext?: { messageId: string; segmentIds: readonly string[] } | undefined
}

export interface StructuredCallRequest {
  beforeProvider?: (() => void | Promise<void>) | undefined
  admission?: import('../resource-quota.js').ResourcePriority
  purpose?: Extract<ModelPurpose, 'content-review' | 'memory-synthesis' | 'approval-explanation'>
  instructions: string
  /** Local diagnostics, never sent as provider request fields. */
  prompt?: import('../context/compiler.js').PromptManifest
  input: unknown
  signal?: AbortSignal | undefined
}

export interface StructuredCallResult {
  value: unknown
  model: string
  usage: ModelUsage
}

export interface CompactionRequest {
  beforeProvider?: (() => void | Promise<void>) | undefined
  /** Only optional candidates may be interrupted to admit foreground work. */
  interruptible?: boolean
  admission?: import('../resource-quota.js').ResourcePriority
  instructions: string
  /** Local diagnostics, never sent as provider request fields. */
  prompt?: import('../context/compiler.js').PromptManifest
  items: readonly ModelItem[]
  signal?: AbortSignal | undefined
}

export interface CompactionResult {
  value: string
  model: string
  usage: ModelUsage
}

export interface ModelDriver {
  /** This wrapper consumes beforeProvider after its last internal capacity wait. */
  deferredAdmission?: true
  readonly recovery?: import('./recovery.js').ModelRecoveryPolicy
  /** Only declare an independent user channel, or a JSON candidate with a top-level body string. */
  readonly previewFormat?: 'candidate-json' | 'user-text'
  /** Explicit public text generation protocol; absent means unknown purpose. */
  readonly publicTextProtocol?: PublicTextProtocol | undefined
  readonly publicTextContinuation?: 'typed-message-v1' | undefined
  readonly profile?: ModelProfile
  /** A provider tokenizer or calibrated upper bound; never a fixed bytes/constant guess. */
  countTokens?(text: string): number
  /** Optional actual generation wire estimate; never used for auxiliary calls. */
  generationInputTokens?(request: Pick<ModelTurnRequest, 'instructions' | 'items' | 'tools' | 'codeExecution'>): number | undefined
  readonly maxThinkingTokens?: number
  /** Runtime owns retries so each outbound request reserves and settles its own budget. */
  singleAttempt?(): ModelDriver
  /** Trusted pre-generation selection for work without public streaming authorization. */
  withPublicTextProtocol?(protocol: PublicTextProtocol): ModelDriver
  nextCallId?(): string
  readonly modelId?: string
  /** Hash of non-secret provider parameters needed to identify a replay configuration. */
  readonly configurationFingerprint?: string
  readonly contextWindowTokens?: number
  readonly maxOutputTokens?: number
  readonly toolDefinitionTokens?: number
  /** Provider-owned wire instructions reserved in addition to runtime input. */
  readonly protocolTokens?: number
  /** One agent-loop turn: one Python call or a structured final candidate. */
  run(request: ModelTurnRequest): Promise<ModelTurnResult>
  /** One-shot JSON-mode call for auxiliary pipelines. */
  structured(request: StructuredCallRequest): Promise<StructuredCallResult>
  /** Summarize `items` into a continuity summary for context compaction. */
  compact(request: CompactionRequest): Promise<CompactionResult>
}
