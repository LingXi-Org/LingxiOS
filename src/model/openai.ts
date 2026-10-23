import type { OutcomeDeclaration, PublicTextProtocol } from './outcome-declaration.js'
import { publicPurposeInstructions, PublicPurposeParser, publicPurposeError } from './public-purpose.js'
import { ToolCompanionBoundary, completeCompanionTurn, companionHasJsonFraming } from './tool-companion.js'
import { NativeToolPublicOutput, NATIVE_TOOL_PUBLIC_OUTPUT_INSTRUCTIONS, wrapNativeToolSchema, wrapNativeToolArguments } from './native-tool-public-output.js'
import { compileToolSchemas, validateToolBatch } from '../runtime/tool-batch.js'
/**
 * OpenAI-compatible chat-completions driver.
 *
 * Uses global `fetch` and bounded SSE parsing without a provider SDK.
 * Works against any endpoint implementing the
 * chat-completions wire format (OpenAI, Azure, vLLM, LiteLLM, …).
 *
 * Protocol discipline enforced here, not in the runtime:
 * - one Python tool; final self-assessment is validated separately by the runtime;
 * - a turn that returns neither text nor a tool call is a driver error with
 *   diagnostics the runtime can use for a bounded protocol-correction retry.
 */
import { IPYTHON_TOOL_NAME } from '../protocol/constants.js'
import { createHash } from 'node:crypto'
import { COMPACTION_INSTRUCTIONS, observationItems } from '../context/compiler.js'
import type { ModelItem } from '../protocol/types.js'
import { ModelDriverError } from '../errors.js'
import type { ModelProfile } from './profile.js'
import { describeTool } from '../tools/catalog.js'
import { acquireCircuit, modelFailure, readProviderErrorCode, providerRequestId, retryAfterMs, recoveryPolicy, type ModelRecoveryPolicy } from './recovery.js'
import { abortable } from '../deadline.js'
import type {
  CompactionRequest, CompactionResult,
  ModelDriver, ModelTurnRequest, ModelTurnResult, ModelUsage,
  StructuredCallRequest, StructuredCallResult,
} from './driver.js'

export const DEFAULT_MODEL = { id: 'deepseek-ai/DeepSeek-V4-Flash', baseUrl: 'https://api.siliconflow.cn/v1', reasoningEffort: 'high' } as const

export type ReasoningEffort = 'low' | 'high' | 'max'

export interface OpenAIDriverOptions {
  publicTextProtocol?: PublicTextProtocol
  /** Opt-in v3 message completion distinct from terminal execution completion. */
  publicTextContinuation?: 'typed-message-v1' | undefined
  /** Explicit single-call v3 wire binding; never inferred from provider prose. */
  nativeToolPublicOutput?: 'envelope-v1' | undefined
  recovery?: Partial<ModelRecoveryPolicy>
  capabilities?: Partial<Pick<ModelProfile, 'toolCalls' | 'jsonObject' | 'jsonObjectWithTools' | 'parallelTools'>>
  /** Calibrated tokenizer for this exact model configuration. */
  countTokens?: (text: string) => number
  maxThinkingTokens?: number
  apiKey: string
  baseUrl?: string
  reasoningEffort?: ReasoningEffort
  /** Independent effort for compaction; omitted by default, without inheriting the main effort. */
  compactionReasoningEffort?: ReasoningEffort
  /** Stream structured and compaction responses internally; disabled by default. */
  auxiliaryStreaming?: boolean
  /** Max attempts per request across retryable failures (429/5xx/network). */
  maxAttempts?: number
  /** Base backoff in ms; grows exponentially with full jitter. */
  retryBaseMs?: number
  /** Per-request timeout in ms (wall clock, including streaming). */
  requestTimeoutMs?: number
  /** Time to first response body byte; headers alone do not count. */
  firstByteTimeoutMs?: number
  /** Maximum gap between response body chunks. */
  streamIdleTimeoutMs?: number
  circuitResetMs?: number
  maxOutputTokens?: number
  contextWindowTokens?: number
  fetchImpl?: typeof fetch
  /** Injectable sleep for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

const IPYTHON_TOOL = {
  type: 'function',
  function: {
    name: IPYTHON_TOOL_NAME,
    description:
      'Execute Python in this session\'s persistent guarded kernel. Product capabilities are '
      + 'available as host.<namespace>.<method>(keyword=value, ...). Strict JSON arguments with '
      + 'exactly one non-empty "code" string.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Python source to execute.' } },
      required: ['code'],
      additionalProperties: false,
    },
  },
} as const

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

function toWireMessages(instructions: string, items: readonly ModelItem[], nativeEnvelope = false): WireMessage[] {
  const messages: WireMessage[] = [{ role: 'system', content: instructions }]
  for (const item of observationItems(items, 'history')) {
    if ('role' in item) {
      messages.push({ role: item.role, content: item.content })
      continue
    }
    if (item.type === 'function_call') {
      let assistant = messages.at(-1)!
      if (assistant.role !== 'assistant') { assistant = { role: 'assistant', content: null }; messages.push(assistant) }
      assistant.tool_calls ??= []
      assistant.tool_calls.push({ id: item.callId, type: 'function', function: { name: item.name,
        arguments: nativeEnvelope ? wrapNativeToolArguments(item.arguments) : item.arguments } })
      continue
    }
    messages.push({ role: 'tool', tool_call_id: item.callId, content: item.output })
  }
  return messages
}

interface ProviderUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

interface StreamAccumulator {
  text: string
  toolCalls: Map<number, { id: string; name: string; arguments: string }>
  finishReasons: string[]
  model?: string
  usage?: ProviderUsage
  malformedToolCalls?: boolean
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, rejectSleep) => {
    const timer = setTimeout(() => { cleanup(); resolveSleep() }, ms)
    const onAbort = () => { cleanup(); rejectSleep(signal?.reason instanceof Error ? signal.reason : new Error('aborted')) }
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function* bodyText(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 16 * 1024 * 1024) throw new ModelDriverError('model response exceeds 16 MiB', { finishReasons: [] })
      yield decoder.decode(value, { stream: true })
    }
    const tail = decoder.decode()
    if (tail) yield tail
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ModelDriverError('model provider returned no response body', { finishReasons: [] })
  let text = ''
  for await (const chunk of bodyText(response.body)) text += chunk
  try { return JSON.parse(text) }
  catch { throw new ModelDriverError('model response contained invalid JSON', { finishReasons: [], kind: 'provider' }) }
}

/** Parse bounded `text/event-stream` bodies into `data:` payload strings. */
export async function* sseDataEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let buffer = ''
  for await (const chunk of bodyText(body)) {
    buffer += chunk
    let boundary: RegExpExecArray | null
    // An SSE event ends at a blank line; tolerate \r\n line endings.
    while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
      const rawEvent = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      const data = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data) yield data
    }
  }
  if (buffer.split(/\r?\n/).some(line => line.trim() && !line.startsWith(':'))) {
    throw new ModelDriverError('model stream ended with an incomplete event', { kind: 'provider', finishReasons: [] })
  }
}

export class OpenAIChatDriver implements ModelDriver {
  readonly recovery: ModelRecoveryPolicy
  readonly previewFormat = 'user-text' as const
  readonly publicTextProtocol: PublicTextProtocol | undefined
  readonly publicTextContinuation: 'typed-message-v1' | undefined
  readonly profile: ModelProfile
  countTokens(text: string): number { return this.options.countTokens?.(text) ?? Buffer.byteLength(text) }
  readonly maxThinkingTokens: number
  readonly protocolTokens: number
  withPublicTextProtocol(publicTextProtocol:PublicTextProtocol):ModelDriver { return new OpenAIChatDriver(this.modelId,{...this.options,publicTextProtocol,
    ...(publicTextProtocol === 'purpose-json-v3' ? {} : { nativeToolPublicOutput: undefined, publicTextContinuation: undefined })}) }
  singleAttempt(): ModelDriver { return new OpenAIChatDriver(this.modelId, { ...this.options, maxAttempts: 1 }) }
  readonly configurationFingerprint: string
  readonly contextWindowTokens: number
  readonly maxOutputTokens: number
  readonly toolDefinitionTokens = new TextEncoder().encode(JSON.stringify(IPYTHON_TOOL)).length
  private readonly baseUrl: string
  private readonly maxAttempts: number
  private readonly retryBaseMs: number
  private readonly requestTimeoutMs: number
  private readonly circuitKey: string
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>

  constructor(readonly modelId: string, private readonly options: OpenAIDriverOptions) {
    this.recovery = recoveryPolicy(options.recovery)
    if(options.publicTextProtocol!==undefined&&!['purpose-json-v1','purpose-json-v2','purpose-json-v3'].includes(options.publicTextProtocol))throw new Error('invalid public text protocol')
    this.publicTextProtocol=options.publicTextProtocol
    if(options.publicTextContinuation!==undefined && (options.publicTextContinuation!=='typed-message-v1'
      || this.publicTextProtocol!=='purpose-json-v3' || options.nativeToolPublicOutput!==undefined))throw new Error('public text continuation requires v3 and original native tool schemas')
    this.publicTextContinuation=options.publicTextContinuation
    this.baseUrl = (options.baseUrl ?? DEFAULT_MODEL.baseUrl).replace(/\/+$/, '')
    this.circuitKey = createHash('sha256').update(JSON.stringify([this.baseUrl, modelId, options.apiKey])).digest('hex')
    for (const key of ['reasoningEffort', 'compactionReasoningEffort'] as const) {
      if (options[key] !== undefined && !['low', 'high', 'max'].includes(options[key])) throw new Error(`${key} must be low, high or max`)
    }
    if (options.auxiliaryStreaming !== undefined && typeof options.auxiliaryStreaming !== 'boolean') throw new Error('auxiliaryStreaming must be a boolean')
    this.maxAttempts = options.maxAttempts ?? 3
    this.retryBaseMs = options.retryBaseMs ?? 500
    this.requestTimeoutMs = options.requestTimeoutMs ?? 90_000
    for (const timeout of [this.requestTimeoutMs, options.firstByteTimeoutMs ?? 30_000, options.streamIdleTimeoutMs ?? 30_000, options.circuitResetMs ?? 60_000]) {
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) throw new Error('invalid model timeout')
    }
    this.fetchImpl = options.fetchImpl ?? fetch
    this.sleep = options.sleep ?? defaultSleep
    this.contextWindowTokens = options.contextWindowTokens ?? 128_000
    this.maxOutputTokens = options.maxOutputTokens ?? 8_192
    this.maxThinkingTokens = options.maxThinkingTokens ?? (options.reasoningEffort ? 2048 : 0)
    if (this.maxThinkingTokens !== 0 && (!Number.isSafeInteger(this.maxThinkingTokens) || this.maxThinkingTokens < 128 || this.maxThinkingTokens > 32768)) throw new Error('maxThinkingTokens must be 0 or 128..32768')
    if (!Number.isSafeInteger(this.maxOutputTokens) || this.maxOutputTokens < 1) throw new Error('maxOutputTokens must be a positive integer')
    if (!Number.isSafeInteger(this.contextWindowTokens) || this.contextWindowTokens <= this.maxOutputTokens) throw new Error('contextWindowTokens must be an integer greater than maxOutputTokens')
    this.profile = Object.freeze({ id: modelId, contextWindowTokens: this.contextWindowTokens, maxOutputTokens: this.maxOutputTokens,
      maxThinkingTokens: this.maxThinkingTokens, toolCalls: true, jsonObject: true, jsonObjectWithTools: true, parallelTools: true, ...options.capabilities })
    for (const key of ['toolCalls', 'jsonObject', 'jsonObjectWithTools', 'parallelTools'] as const) {
      if (typeof this.profile[key] !== 'boolean') throw new Error(`invalid model capability ${key}`)
    }
    if (options.nativeToolPublicOutput !== undefined && (options.nativeToolPublicOutput !== 'envelope-v1'
      || this.publicTextProtocol !== 'purpose-json-v3' || this.profile.jsonObjectWithTools !== false || this.profile.parallelTools !== false)) {
      throw new Error('native tool public output requires explicit v3, no combined JSON mode, and single native calls')
    }
    this.protocolTokens=this.publicTextProtocol?this.countTokens(publicPurposeInstructions(this.publicTextProtocol,this.profile,this.publicTextContinuation)):0
    // Default and explicit support share the same capability representation;
    // only an opt-out adds that capability field. Parsing policy is separately
    // versioned below and intentionally changes replay identity when revised.
    const { jsonObjectWithTools, ...legacyCapabilities } = this.profile
    this.configurationFingerprint = createHash('sha256').update(JSON.stringify({
      wire: 'openai-chat-completions-v1', model: modelId, baseUrl: this.baseUrl,
      toolDeltaPolicy: 'nullable-optional-metadata-v1',
      reasoningEffort: options.reasoningEffort ?? null, maxOutputTokens: this.maxOutputTokens,
      contextWindowTokens: this.contextWindowTokens, maxThinkingTokens: this.maxThinkingTokens, compactionThinking: false, tool: 'ipython-v1',
      capabilities: jsonObjectWithTools === false ? { ...legacyCapabilities, jsonObjectWithTools: false } : legacyCapabilities,
      previewFormat: this.previewFormat,
      ...(this.publicTextProtocol?{publicTextProtocol:this.publicTextProtocol}:{}),
      ...(this.publicTextProtocol==='purpose-json-v3'?{publicPurposeInstructionsPolicy:'v3-native-tool-phases-v1',publicPurposeParserPolicy:'optional-commentary-v1'}:{}),
      ...(this.publicTextProtocol && jsonObjectWithTools === false ? { toolCompanionPolicy: 'unpublished-native-prose-v1' } : {}),
      ...(options.compactionReasoningEffort ? { compactionReasoningEffort: options.compactionReasoningEffort } : {}),
      ...(options.auxiliaryStreaming ? { auxiliaryStreaming: true } : {}),
      ...(this.publicTextContinuation ? { publicTextContinuation: this.publicTextContinuation } : {}),
      ...(options.nativeToolPublicOutput ? { nativeToolPublicOutput: options.nativeToolPublicOutput,
        nativeToolIdentityPolicy: 'bounded-unambiguous-prefix-v1' } : {}),
    })).digest('hex')
  }

  private async request(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const encoded = JSON.stringify({ max_tokens: this.maxOutputTokens,
      ...(this.options.maxThinkingTokens !== undefined || this.options.reasoningEffort ? { enable_thinking: this.maxThinkingTokens > 0 } : {}),
      ...(this.maxThinkingTokens ? { thinking_budget: this.maxThinkingTokens } : {}),
      ...(this.options.reasoningEffort ? { reasoning_effort: this.options.reasoningEffort } : {}), ...body })
    let lastError: unknown
    const totalTimeout = AbortSignal.timeout(this.recovery.totalTimeoutMs)
    const totalSignal = AbortSignal.any([...(signal ? [signal] : []), totalTimeout])
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      totalSignal.throwIfAborted()
      const timeout = AbortSignal.timeout(this.requestTimeoutMs)
      const combined = AbortSignal.any([totalSignal, timeout])
      const firstByte = new AbortController()
      const firstByteTimer = setTimeout(() => firstByte.abort(new DOMException('model first byte timed out', 'TimeoutError')),
        this.options.firstByteTimeoutMs ?? 30_000)
      firstByteTimer.unref()
      const clearFirstByte = () => clearTimeout(firstByteTimer)
      const headersSignal = AbortSignal.any([combined, firstByte.signal])
      let response: Response
      try {
        response = await abortable(this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.options.apiKey}`,
          },
          body: encoded,
          signal: headersSignal,
        }), headersSignal)
      } catch (error) {
        clearFirstByte()
        totalSignal.throwIfAborted()
        lastError = error
        if (attempt === this.maxAttempts) break
        await this.sleep(this.backoffMs(attempt), totalSignal)
        continue
      }
      if (response.ok) return this.boundedResponse(response, headersSignal, firstByte.signal, clearFirstByte)
      clearFirstByte()
      const status = response.status
      const code = await readProviderErrorCode(response,combined)
      const requestId = providerRequestId(response.headers.get('x-request-id') ?? response.headers.get('request-id'))
      const retryAfter = retryAfterMs(response.headers.get('retry-after'))
      const failure = new ModelDriverError(`model provider returned ${status}`, { status, finishReasons: [], attempts: attempt,
        ...(requestId ? { requestId } : {}), ...(code ? { providerCode: code } : {}),
        ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) })
      if (modelFailure(failure).retryable && attempt < this.maxAttempts) {
        await this.sleep(Math.max(retryAfter ?? 0, this.backoffMs(attempt)), totalSignal)
        lastError = failure
        continue
      }
      throw failure
    }
    throw new ModelDriverError(
      `model request failed after ${this.maxAttempts} attempts`,
      { finishReasons: [], attempts: this.maxAttempts },
      { cause: lastError },
    )
  }

  private boundedResponse(response: Response, signal: AbortSignal, firstByte: AbortSignal, clearFirstByte: () => void): Response {
    if (!response.body) { clearFirstByte(); return response }
    const reader = response.body.getReader()
    let first = true, finished = false
    const cancel = () => {
      if (finished) return
      finished = true
      clearFirstByte()
      void reader.cancel().catch(() => {}).finally(() => reader.releaseLock())
    }
    const body = new ReadableStream<Uint8Array>({
      pull: async controller => {
        if (finished) return
        const idle = first ? firstByte : AbortSignal.timeout(this.options.streamIdleTimeoutMs ?? 30_000)
        try {
          const chunk = await abortable(reader.read(), AbortSignal.any([signal, idle]))
          if (chunk.done) { finished = true; clearFirstByte(); reader.releaseLock(); controller.close(); return }
          first = false
          clearFirstByte()
          controller.enqueue(chunk.value)
        } catch (error) {
          cancel()
          controller.error(new ModelDriverError('model response timed out or disconnected', {
            category: modelFailure(error).category, kind: 'provider', finishReasons: [],
          }, { cause: error }))
        }
      },
      cancel,
    })
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }

  private async guarded<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    const settle = acquireCircuit(this.circuitKey, this.options.circuitResetMs ?? 60_000)
    try {
      const result = await operation()
      settle()
      return result
    } catch (error) {
      const failure = modelFailure(error, signal?.aborted)
      settle(failure, error instanceof ModelDriverError ? error.diagnostics.attempts : undefined)
      if (signal?.aborted || error instanceof ModelDriverError || failure.category === 'unknown') throw error
      throw new ModelDriverError('model request failed', { kind: 'provider', category: failure.category, finishReasons: [] }, { cause: error })
    }
  }

  private backoffMs(attempt: number): number {
    const cap = Math.min(this.retryBaseMs * 2 ** (attempt - 1), 20_000)
    return Math.floor(Math.random() * cap)
  }

  private async consumeStream(response: Response, onTextDelta?: ModelTurnRequest['onTextDelta'],
    onToolDelta?: (index: number, call: { id: string; name: string; arguments: string }, delta: string) => Promise<void>): Promise<StreamAccumulator> {
    if (!response.body) throw new ModelDriverError('model provider returned no response body', { finishReasons: [] })
    const accumulator: StreamAccumulator = { text: '', toolCalls: new Map(), finishReasons: [] }
    try {
      for await (const data of sseDataEvents(response.body)) {
        if (data === '[DONE]') break
        let chunk: {
          model?: string
          usage?: ProviderUsage | null
          choices?: Array<{
            finish_reason?: string | null
            delta?: {
              content?: string | null
              tool_calls?: Array<{ index?: number; id?: string | null; type?: string | null; function?: { name?: string | null; arguments?: string | null } | null }>
            }
          }>
        }
        try {
          chunk = JSON.parse(data)
        } catch {
          throw new ModelDriverError('model stream contained invalid JSON', { kind: 'provider', finishReasons: accumulator.finishReasons })
        }
        if (chunk.model) accumulator.model = chunk.model
        if (chunk.usage) accumulator.usage = chunk.usage
        const choice = chunk.choices?.[0]
        if (!choice) continue
        if (chunk.choices!.length > 1 || accumulator.finishReasons.length && (choice.delta?.content || choice.delta?.tool_calls?.length)) {
          accumulator.malformedToolCalls = true
        }
        if (choice.finish_reason) accumulator.finishReasons.push(choice.finish_reason)
        const content = choice.delta?.content
        if (typeof content === 'string' && content.length > 0) {
          accumulator.text += content
          await onTextDelta?.(content)
        }
        for (const toolCall of choice.delta?.tool_calls ?? []) {
          const index = toolCall.index ?? 0
          if (!Number.isSafeInteger(index) || index < 0 || toolCall.index !== undefined && !Number.isSafeInteger(toolCall.index)
            || toolCall.type != null && toolCall.type !== 'function'
            || toolCall.function != null && (typeof toolCall.function !== 'object' || Array.isArray(toolCall.function))) accumulator.malformedToolCalls = true
          let entry = accumulator.toolCalls.get(index)
          if (!entry) {
            entry = { id: '', name: '', arguments: '' }
            accumulator.toolCalls.set(index, entry)
          }
          // OpenAPI nullable delta fields mean "not supplied in this chunk".
          // Preserve already accumulated identity; final validation is unchanged.
          if (toolCall.id != null) {
            if (typeof toolCall.id !== 'string' || entry.id && entry.id !== toolCall.id) accumulator.malformedToolCalls = true
            if (typeof toolCall.id === 'string') entry.id = toolCall.id
          }
          if (toolCall.function?.name != null) {
            if (typeof toolCall.function.name !== 'string') accumulator.malformedToolCalls = true
            else entry.name += toolCall.function.name
          }
          if (toolCall.function?.arguments != null) {
            if (typeof toolCall.function.arguments !== 'string') accumulator.malformedToolCalls = true
            else entry.arguments += toolCall.function.arguments
          }
          if (onToolDelta) await onToolDelta(index, entry, typeof toolCall.function?.arguments === 'string' ? toolCall.function.arguments : '')
        }
      }
    } catch (error) { this.throwStreamFailure(error, accumulator) }
    return accumulator
  }

  private throwStreamFailure(error: unknown, accumulator: StreamAccumulator): never {
    const usage = this.usageOf(accumulator)
    if (!usage.available && !(error instanceof ModelDriverError)) throw error
    const diagnostics = error instanceof ModelDriverError ? error.diagnostics
      : { kind: 'provider' as const, category: modelFailure(error).category, finishReasons: accumulator.finishReasons }
    throw new ModelDriverError(error instanceof ModelDriverError ? error.message : 'model stream failed',
      { ...diagnostics, category: diagnostics.category ?? modelFailure(error).category,
        finishReasons: diagnostics.finishReasons.length ? diagnostics.finishReasons : accumulator.finishReasons,
        ...(diagnostics.usage?.available ? { usage: diagnostics.usage } : usage.available ? { usage } : {}) }, { cause: error })
  }

  private usageOf(accumulator: Pick<StreamAccumulator, 'usage'>): ModelUsage {
    const usage = accumulator.usage
    if (!usage || (usage.prompt_tokens === undefined && usage.completion_tokens === undefined)) {
      return { available: false, inputTokens: 0, outputTokens: 0 }
    }
    const input = usage.prompt_tokens, output = usage.completion_tokens
    if (![input, output].every(value => Number.isSafeInteger(value) && value! >= 0)) return { available: false, inputTokens: 0, outputTokens: 0 }
    const cached = usage.prompt_tokens_details?.cached_tokens, reasoning = usage.completion_tokens_details?.reasoning_tokens
    return { available: true, inputTokens: input!, outputTokens: output!,
      ...(Number.isSafeInteger(cached) && cached! >= 0 && cached! <= input! ? { cachedInputTokens: cached! } : {}),
      ...(Number.isSafeInteger(reasoning) && reasoning! >= 0 && reasoning! <= output! ? { reasoningTokens: reasoning! } : {}) }
  }

  run(request: ModelTurnRequest): Promise<ModelTurnResult> {
    return this.guarded(() => this.runOnce(request), request.signal)
  }
  private generationInstructions(instructions: string, nativeEnvelope: boolean): string {
    return instructions + (nativeEnvelope ? '\n\n' + NATIVE_TOOL_PUBLIC_OUTPUT_INSTRUCTIONS
      : this.publicTextProtocol ? '\n\n' + publicPurposeInstructions(this.publicTextProtocol, this.profile, this.publicTextContinuation) : '')
  }
  /** Actual provider wire estimate only for agent generation. Auxiliary methods
   * use their existing independent payloads and never enter this binding. */
  generationInputTokens(request: Pick<ModelTurnRequest, 'instructions' | 'items' | 'tools' | 'codeExecution'>): number | undefined {
    if (!this.options.nativeToolPublicOutput) return undefined
    const allowPython = request.codeExecution === 'enabled' || request.codeExecution === undefined && request.tools === undefined
    const tools = [ ...(allowPython ? [IPYTHON_TOOL] : []), ...(request.tools ?? []).map(tool => ({ type: 'function' as const,
      function: { name: tool.name, description: describeTool(tool), parameters: tool.parameters } })) ]
    const nativeEnvelope = tools.length > 0
    return this.countTokens(JSON.stringify({ messages: toWireMessages(this.generationInstructions(request.instructions, nativeEnvelope),
      request.items, nativeEnvelope), ...(tools.length ? { tools: tools.map(tool => ({ ...tool, function: { ...tool.function,
        parameters: wrapNativeToolSchema(tool.function.parameters) } })), tool_choice: 'auto', parallel_tool_calls: false } : {}) }))
  }
  private async runOnce(request: ModelTurnRequest): Promise<ModelTurnResult> {
    const allowPython = request.codeExecution === 'enabled' || request.codeExecution === undefined && request.tools === undefined
    const tools = [
      ...(allowPython ? [IPYTHON_TOOL] : []),
      ...(request.tools ?? []).map(tool => ({ type: 'function' as const, function: { name: tool.name, description: describeTool(tool), parameters: tool.parameters } })),
    ]
    if (tools.length && !this.profile.toolCalls) throw new Error('selected model does not support tool calls')
    const nativeEnvelope = !!this.options.nativeToolPublicOutput && tools.length > 0
    const wireTools = nativeEnvelope ? tools.map(tool => ({ ...tool, function: { ...tool.function,
      parameters: wrapNativeToolSchema(tool.function.parameters) } })) : tools
    if (nativeEnvelope) {
      compileToolSchemas(request.tools ?? [])
      compileToolSchemas(wireTools.map(tool => ({ name: tool.function.name, action: tool.function.name,
        description: tool.function.description, effect: 'read', approval: false,
        parameters: tool.function.parameters as import('../tools/catalog.js').ToolDefinition['parameters'] })))
    }
    if(this.publicTextProtocol&&!this.profile.jsonObject)throw new Error('public text protocol requires JSON object support')
    const purposeParser=this.publicTextProtocol?new PublicPurposeParser(this.publicTextProtocol):undefined
    let operationPublished=false
    let nativeOutput: NativeToolPublicOutput | undefined
    let nativeIdentity: { id: string; name: string } | undefined
    let nativeCallId: string | undefined
    let nativeCallObserved = false
    let contentObserved = false
    const companion = purposeParser && tools.length && this.profile.jsonObjectWithTools === false ? new ToolCompanionBoundary() : undefined
    const acceptNativeDelta = async (index: number, call: { id: string; name: string; arguments: string }, delta: string, finalIdentity = false) => {
      request.signal?.throwIfAborted()
      nativeCallObserved = true
      if (index !== 0 || contentObserved || call.id.trim() !== call.id
        || nativeCallId && nativeCallId !== call.id
        || nativeIdentity && (nativeIdentity.id !== call.id || nativeIdentity.name !== call.name)) throw publicPurposeError()
      if (call.id) nativeCallId ??= call.id
      let publicDelta = delta
      if (!nativeIdentity) {
        // A catalog name may itself prefix another name. Keep original bytes
        // private until the identity is unique, or a valid turn confirms it.
        const candidates = tools.filter(tool => tool.function.name.startsWith(call.name))
        if (Buffer.byteLength(call.arguments) > 16 * 1024 * 1024 || !candidates.length) throw publicPurposeError()
        if (!call.id || !candidates.some(tool => tool.function.name === call.name) || !call.arguments
          || !finalIdentity && candidates.length > 1) return
        nativeIdentity = { id: call.id, name: call.name }
        nativeOutput = new NativeToolPublicOutput()
        publicDelta = call.arguments
      }
      if (!publicDelta) return
      const outputParser = nativeOutput!
      const parts = outputParser.push(publicDelta)
      if (outputParser.operation && !operationPublished) {
        await request.onTextOperation?.(outputParser.operation); operationPublished = true
        request.signal?.throwIfAborted()
      }
      for (const part of parts) {
        request.signal?.throwIfAborted()
        await request.onTextDelta?.(part.text, { purpose: part.purpose })
        request.signal?.throwIfAborted()
      }
    }
    const response = await this.request({
      model: this.modelId,
      messages: toWireMessages(this.generationInstructions(request.instructions, nativeEnvelope), request.items, nativeEnvelope),
      ...(purposeParser && (!tools.length || this.profile.jsonObjectWithTools !== false) ? { response_format: { type: 'json_object' } } : {}),
      ...(tools.length ? { tools: wireTools, tool_choice: 'auto', parallel_tool_calls: this.profile.parallelTools } : {}),
      stream: true,
      stream_options: { include_usage: true },
    }, request.signal)
    const accumulator = await this.consumeStream(response, purposeParser?async chunk=>{
      request.signal?.throwIfAborted()
      if (companion) { const framed = companion.push(chunk); if (framed === null) return; chunk = framed }
      contentObserved = true
      if (nativeCallObserved) throw publicPurposeError()
      const parts=purposeParser.push(chunk)
      if(purposeParser.operation&&!operationPublished){await request.onTextOperation?.(purposeParser.operation);operationPublished=true}
      for(const part of parts){
        request.signal?.throwIfAborted()
        await request.onTextDelta?.(part.text,{purpose:part.purpose})
        request.signal?.throwIfAborted()
      }
    }:request.onTextDelta, nativeEnvelope ? acceptNativeDelta : undefined)
    const diagnostics = { finishReasons: accumulator.finishReasons, usage: this.usageOf(accumulator) }
    if (request.signal?.aborted) throw new ModelDriverError('model request cancelled', {
      ...diagnostics, kind: 'provider', category: 'cancelled',
    }, { cause: request.signal.reason })
    if (!accumulator.finishReasons.length || accumulator.finishReasons.some(reason => reason !== 'stop' && reason !== 'tool_calls')) {
      throw new ModelDriverError('model stream did not finish normally', { ...diagnostics, kind: 'provider' })
    }
    if(this.publicTextProtocol==='purpose-json-v3'&&(accumulator.malformedToolCalls||accumulator.finishReasons.length!==1
      ||accumulator.finishReasons[0] !== (accumulator.toolCalls.size?'tool_calls':'stop'))){
      throw new ModelDriverError('invalid model turn boundary',{...diagnostics,kind:'protocol',category:'protocol',protocolCode:'tool_identity_invalid'})
    }
    const output: ModelItem[] = []
    let text = accumulator.text
    let outcomeDeclaration:OutcomeDeclaration|undefined
    let publicTextPhase:ModelTurnResult['publicTextPhase']
    if (nativeEnvelope && accumulator.toolCalls.size) {
      if (!nativeOutput && !contentObserved && !companionHasJsonFraming(accumulator.text)
        && completeCompanionTurn({ text: '', calls: accumulator.toolCalls, finishReasons: accumulator.finishReasons },
          tools.map(tool => tool.function.name), false)) {
        try { await acceptNativeDelta(0, accumulator.toolCalls.get(0)!, '', true) }
        catch (error) { this.throwStreamFailure(error, accumulator) }
      }
      if (!nativeOutput || contentObserved || companionHasJsonFraming(accumulator.text)) {
        throw new ModelDriverError('invalid native public output envelope', { ...diagnostics, kind: 'protocol', category: 'protocol', protocolCode: !nativeOutput ? 'native_envelope_invalid' : 'public_text_invalid' })
      }
      let decoded: ReturnType<NativeToolPublicOutput['finish']>
      try { decoded = nativeOutput.finish() }
      catch { throw new ModelDriverError('invalid native public output envelope', { ...diagnostics, kind: 'protocol', category: 'protocol', protocolCode: 'native_envelope_invalid' }) }
      text = decoded.text
      accumulator.toolCalls.get(0)!.arguments = decoded.arguments
    } else if (companion?.unpublished) {
      if (!completeCompanionTurn({ text, calls: accumulator.toolCalls, finishReasons: accumulator.finishReasons,
        ...(accumulator.malformedToolCalls ? { malformed: true } : {}) }, tools.map(tool => tool.function.name), this.profile.parallelTools)) {
        const publicTextFailure = !accumulator.toolCalls.size || companionHasJsonFraming(text)
        throw new ModelDriverError(publicTextFailure ? 'invalid public text protocol' : 'invalid native tool companion turn', {
          ...diagnostics, kind: 'protocol', category: 'protocol', protocolCode: publicTextFailure ? 'public_text_invalid' : 'tool_identity_invalid',
        })
      }
      text = ''
    } else if(purposeParser){
      try {
        if(text.length){
          purposeParser.finish()
          text=(JSON.parse(text) as {answer:string|null}).answer ?? ''
        }
        if(this.publicTextProtocol==='purpose-json-v2'||this.publicTextProtocol==='purpose-json-v3'){
          if(accumulator.toolCalls.size){if(accumulator.text.length&&purposeParser.outcome!==null)throw publicPurposeError()}
          else if(purposeParser.outcome===null && this.publicTextContinuation==='typed-message-v1') {
            if(!text.trim() || purposeParser.answerIsNull || !purposeParser.operation)throw publicPurposeError('public_text_answer_required')
            publicTextPhase='intermediate'
          } else {if(purposeParser.outcome===null)throw new ModelDriverError('terminal response requires an outcome declaration', {
            ...diagnostics, kind:'protocol', category:'protocol', protocolCode:'terminal_outcome_required',
          });if(!purposeParser.outcome)throw publicPurposeError();outcomeDeclaration=purposeParser.outcome}
        }
        if(!accumulator.toolCalls.size&&!text.trim()&&!(this.publicTextProtocol==='purpose-json-v3'&&purposeParser.answerIsNull
          &&request.answerContext?.segmentIds.length))throw publicPurposeError('public_text_answer_required')
      }catch(error){throw new ModelDriverError('invalid public text protocol',{
        ...diagnostics,kind:'protocol',category:'protocol',
        protocolCode:error instanceof ModelDriverError ? error.diagnostics.protocolCode ?? 'public_text_invalid' : 'public_text_invalid',
      })}
    }
    if (text.trim()) output.push({ role: 'assistant', content: text })
    const toolCalls = [...accumulator.toolCalls.entries()].sort(([a], [b]) => a - b)
    if(this.publicTextProtocol==='purpose-json-v3'&&toolCalls.length&&!completeCompanionTurn({text:'',calls:accumulator.toolCalls,
      finishReasons:accumulator.finishReasons,...(accumulator.malformedToolCalls?{malformed:true}:{})},tools.map(tool=>tool.function.name),this.profile.parallelTools)){
      throw new ModelDriverError('invalid native tool batch',{...diagnostics,kind:'protocol',category:'protocol',protocolCode:'tool_identity_invalid'})
    }
    for (const [, call] of this.profile.parallelTools ? toolCalls : toolCalls.slice(0, 1)) {
      if (!call.id.trim()
        || call.name === IPYTHON_TOOL_NAME && !allowPython
        || call.name !== IPYTHON_TOOL_NAME && !request.tools?.some(tool => tool.name === call.name)) {
        throw new ModelDriverError('model returned an invalid tool identity', { ...diagnostics, kind: 'protocol', protocolCode: 'tool_identity_invalid' })
      }
      output.push({
        type: 'function_call',
        callId: call.id,
        name: call.name,
        arguments: call.arguments.trim(),
      })
    }
    if (nativeEnvelope && toolCalls.length) {
      try { validateToolBatch(output.filter((item): item is Extract<ModelItem, { type: 'function_call' }> => 'type' in item && item.type === 'function_call'),
        request.tools ?? [], allowPython ? 'enabled' : 'disabled', false) }
      catch { throw new ModelDriverError('invalid native business arguments', { ...diagnostics, kind: 'protocol', category: 'protocol', protocolCode: 'tool_identity_invalid' }) }
    }
    if (output.length === 0 && !(this.publicTextProtocol==='purpose-json-v3'&&purposeParser?.answerIsNull&&request.answerContext?.segmentIds.length&&outcomeDeclaration)) {
      throw new ModelDriverError('model returned neither assistant text nor a tool call', {
        ...diagnostics, kind: 'protocol', protocolCode: 'response_empty',
      })
    }
    const result: ModelTurnResult = { output, text, usage: diagnostics.usage, ...(publicTextPhase ? {publicTextPhase} : {}), ...(outcomeDeclaration ? { outcomeDeclaration } : {}) }
    if(this.publicTextProtocol==='purpose-json-v3'&&purposeParser?.operation){result.answerOperation=purposeParser.operation;result.answerIsNull=purposeParser.answerIsNull}
    if (nativeOutput?.operation) { result.answerOperation = nativeOutput.operation; result.answerIsNull = false }
    if (accumulator.model !== undefined) result.model = accumulator.model
    if (accumulator.finishReasons.length > 0) result.diagnostics = { finishReasons: accumulator.finishReasons,
      ...(companion?.unpublished ? { publicText: 'unpublished_tool_companion' } : {}) }
    return result
  }

  structured(request: StructuredCallRequest): Promise<StructuredCallResult> {
    return this.guarded(() => this.structuredOnce(request), request.signal)
  }

  private async auxiliaryPayload(response: Response): Promise<{
    content: string | null | undefined
    model: string
    diagnostics: { finishReasons: string[]; usage: ModelUsage }
  }> {
    if (this.options.auxiliaryStreaming) {
      // Auxiliary content is internal: never pass a preview callback or expose reasoning fields.
      const accumulator = await this.consumeStream(response)
      const diagnostics = { finishReasons: accumulator.finishReasons, usage: this.usageOf(accumulator) }
      if (!diagnostics.finishReasons.length || diagnostics.finishReasons.some(reason => reason !== 'stop') || accumulator.toolCalls.size) {
        throw new ModelDriverError('model response did not finish normally', diagnostics)
      }
      return { content: accumulator.text, model: accumulator.model ?? this.modelId, diagnostics }
    }
    const payload = await responseJson(response) as {
      model?: string
      usage?: ProviderUsage
      choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null } }>
    }
    const diagnostics = { finishReasons: [payload.choices?.[0]?.finish_reason ?? 'missing'], usage: this.usageOf({ usage: payload.usage ?? {} }) }
    if (payload.choices?.[0]?.finish_reason !== 'stop') throw new ModelDriverError('model response did not finish normally', diagnostics)
    return { content: payload.choices?.[0]?.message?.content, model: payload.model ?? this.modelId, diagnostics }
  }

  private async structuredOnce(request: StructuredCallRequest): Promise<StructuredCallResult> {
    if (!this.profile.jsonObject) throw new Error('selected model does not support JSON object output')
    const response = await this.request({
      model: this.modelId,
      messages: [
        { role: 'system', content: request.instructions },
        { role: 'user', content: JSON.stringify(request.input) },
      ],
      response_format: { type: 'json_object' },
      stream: this.options.auxiliaryStreaming ?? false,
      ...(this.options.auxiliaryStreaming ? { stream_options: { include_usage: true } } : {}),
    }, request.signal)
    const { content, model, diagnostics } = await this.auxiliaryPayload(response)
    if (typeof content !== 'string' || !content.trim()) {
      throw new ModelDriverError('structured call returned no content', { ...diagnostics, finishReasons: [] })
    }
    let value: unknown
    try {
      value = JSON.parse(content)
    } catch {
      throw new ModelDriverError('structured call returned invalid JSON', { ...diagnostics, finishReasons: [] })
    }
    return { value, model, usage: diagnostics.usage }
  }

  compact(request: CompactionRequest): Promise<CompactionResult> {
    return this.guarded(() => this.compactOnce(request), request.signal)
  }
  private async compactOnce(request: CompactionRequest): Promise<CompactionResult> {
    if (!this.profile.jsonObject) throw new Error('selected model does not support JSON object output')
    const response = await this.request({
      model: this.modelId,
      ...(this.options.maxThinkingTokens !== undefined || this.options.reasoningEffort || this.options.compactionReasoningEffort
        ? { enable_thinking: false, thinking_budget: undefined, reasoning_effort: this.options.compactionReasoningEffort } : {}),
      messages: [
        {
          role: 'system',
          content: COMPACTION_INSTRUCTIONS,
        },
        { role: 'user', content: JSON.stringify(request.items) },
      ],
      response_format: { type: 'json_object' },
      stream: this.options.auxiliaryStreaming ?? false,
      ...(this.options.auxiliaryStreaming ? { stream_options: { include_usage: true } } : {}),
    }, request.signal)
    const { content, model, diagnostics } = await this.auxiliaryPayload(response)
    if (typeof content !== 'string' || !content.trim()) {
      throw new ModelDriverError('compaction returned no summary', { ...diagnostics, finishReasons: [] })
    }
    return { value: content.trim(), model, usage: diagnostics.usage }
  }
}
