import { COMPACTION_PROMPT, textSha256, type PromptManifest } from '../context/compiler.js'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { ModelBudgetExceededError, ModelContextBudgetError, ModelDriverError } from '../errors.js'
import type { HostPort } from '../host/port.js'
import { executionClassOf, type RunEvent, type WorkItem } from '../protocol/types.js'
import type { ModelDriver, ModelUsage } from './driver.js'
import { abortable } from '../deadline.js'
import { fitsModel, inputTokens as estimateInputTokens, modelProfile } from './profile.js'
import { modelFailure, recoveryPolicy, type ModelFailure } from './recovery.js'
import type { ModelBudgetLimits } from '../control-plane/stores.js'

export interface ModelPricing {
  version: string
  currency: 'USD'
  inputMicrosPerMillion: number
  outputMicrosPerMillion: number
}
export function modelPricing(limits: Pick<Required<RootModelBudgetOptions>, 'inputCostMicrosPerMillion' | 'outputCostMicrosPerMillion'>): ModelPricing {
  return { version: createHash('sha256').update(JSON.stringify([limits.inputCostMicrosPerMillion, limits.outputCostMicrosPerMillion])).digest('hex'),
    currency: 'USD', inputMicrosPerMillion: limits.inputCostMicrosPerMillion, outputMicrosPerMillion: limits.outputCostMicrosPerMillion }
}

export interface ModelCallObservation {
  cost?: { amountMicros: number; usage: 'measured' | 'estimated'; pricing: ModelPricing }
  prompt?: PromptManifest
  instructionsSha256?: string
  callId: string
  logicalCallId?: string
  purpose: 'agent-turn' | 'structured' | 'compaction' | 'embedding'
  workId: string
  tenantId: string
  agentId: string
  sessionId: string
  threadId?: string
  principalId?: string
  model: string
  usage?: ModelUsage
  latencyMs: number
  firstContentMs?: number
  configurationFingerprint?: string
  status: 'succeeded' | 'failed'
  error?: string
  failure?: ModelFailure
  attempt?: number
  elapsedMs?: number
}
export type ModelCallObserver = (observation: ModelCallObservation, context?: import('../control-plane/outbox.js').DeliveryContext) => Promise<void>
export interface RootModelBudgetOptions {
  maxModelCalls?: number
  maxTokens?: number
  maxCostMicros?: number
  /** Cumulative execution time across attempts and children; excludes parked waits. */
  wallClockMs?: number
  inputCostMicrosPerMillion?: number
  outputCostMicrosPerMillion?: number
}
export const DEFAULT_MODEL_BUDGET: Required<RootModelBudgetOptions> = {
  maxModelCalls: 128, maxTokens: 1_000_000, maxCostMicros: 10_000_000,
  wallClockMs: 1_800_000, inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0,
}

/** Trusted host configuration only; embeddings intentionally have no fallback route. */
export interface ApprovedModelFallback {
  model: ModelDriver
  /** This route must use the same approved price schedule as the root budget. */
  inputCostMicrosPerMillion: number
  outputCostMicrosPerMillion: number
  /** Recheck tenant, data boundary and current request authorization before every routed attempt. */
  authorize(context: { work: Omit<WorkItem,'leaseToken'>; purpose: ModelCallObservation['purpose']; signal: AbortSignal }): Promise<void>
}

/** One provider attempt boundary shared by generation, reviews, compaction and embeddings. */
export function modelExecution(host: Pick<HostPort, 'reserveModelCall' | 'recordModelUsage'>,
  model: Pick<ModelDriver, 'modelId' | 'maxOutputTokens' | 'maxThinkingTokens' | 'toolDefinitionTokens' | 'protocolTokens' | 'countTokens' | 'configurationFingerprint' | 'recovery' | 'profile' | 'contextWindowTokens'>, work: WorkItem,
  limits: Required<RootModelBudgetOptions>,
  emit?: (event: Omit<RunEvent, 'runId' | 'seq'>) => Promise<unknown>, namespace = 'model', memoryAdmission?: () => number | boolean | undefined) {
  let sequence = 0, calls = 0, tokens = 0, cost = 0
  const started = Date.now()
  const invoke = async <T extends { model?: string; usage: ModelUsage }>(purpose: ModelCallObservation['purpose'],
    request: { signal?: AbortSignal | undefined; input?: unknown; instructions?: string; prompt?: PromptManifest },
    operation: (signal: AbortSignal, callId: string, diagnostics: Record<string, unknown>, selected: typeof model,
      admit?: () => Promise<void>) => Promise<T>,
    callModel = model, fallback?: { model: typeof model; authorize(signal: AbortSignal): Promise<void> }): Promise<T> => {
    const instructionsSha256 = request.instructions === undefined ? undefined : textSha256(request.instructions)
    if (request.prompt && request.prompt.instructionsSha256 !== instructionsSha256) throw new Error('prompt manifest does not match model instructions')
    const logicalCallId = `${work.id}:${work.fence}:${namespace}:${++sequence}`
    const memoryVersion=memoryAdmission?.()
    const recovery = recoveryPolicy(callModel.recovery), logicalBegan = performance.now()
    const totalTimeout = AbortSignal.timeout(Math.min(recovery.totalTimeoutMs, limits.wallClockMs))
    const logicalSignal = AbortSignal.any([...(request.signal ? [request.signal] : []), totalTimeout])
    const deadlineFailure = (rootTimeout?: AbortSignal, first?: AbortSignal) => request.signal?.aborted ? request.signal.reason
      : (rootTimeout?.aborted && first?.reason === rootTimeout.reason) || (totalTimeout.aborted && limits.wallClockMs <= recovery.totalTimeoutMs) ? new ModelBudgetExceededError('Root work execution time exhausted', 'deadline')
      : new ModelDriverError('Model request exceeded its total deadline', { kind: 'provider', category: 'timeout', finishReasons: [] })
    const { prompt: _prompt, ...providerRequest } = request
    let routed = false
    for (let attempt = 1; ; attempt++) {
      if (logicalSignal.aborted) throw deadlineFailure()
      if (routed) await abortable(fallback!.authorize(logicalSignal),logicalSignal).catch(error => {
        throw logicalSignal.aborted ? deadlineFailure() : error
      })
      const input = estimateInputTokens(callModel, providerRequest, purpose==='agent-turn') + (callModel.toolDefinitionTokens ?? 0)
      const output = (callModel.maxOutputTokens ?? 8192) + (callModel.maxThinkingTokens ?? 0)
      const reservedCost = Math.ceil((input * limits.inputCostMicrosPerMillion + output * limits.outputCostMicrosPerMillion) / 1_000_000)
      const dimension = Date.now() - started >= limits.wallClockMs ? 'deadline' : calls >= limits.maxModelCalls ? 'calls'
        : tokens + input + output > limits.maxTokens ? 'tokens' : cost + reservedCost > limits.maxCostMicros ? 'cost' : undefined
      if (dimension) throw new ModelBudgetExceededError('Root work budget limit reached', dimension)
      const callId = attempt === 1 ? logicalCallId : `${logicalCallId}:retry:${attempt}`
      const reserved: ModelBudgetLimits = {
        ...limits, maxExecutionMs: limits.wallClockMs,
        deadlineAt: new Date(Date.now() + limits.wallClockMs).toISOString(),
        reservedTokens: input + output, reservedInputTokens: input, reservedOutputTokens: output, reservedCostMicros: reservedCost,
        pricing: modelPricing(limits),
        ...(typeof memoryVersion==='number' ? {memoryRequestVersion:memoryVersion} : {}),
        ...(purpose === 'agent-turn' ? { childAdmission: {
          inputTokens: input,
          outputTokens: output, executionMs: recovery.totalTimeoutMs,
        } } : {}),
      }
      const reservation = await host.reserveModelCall(work, callId, reserved)
      if (!reservation.allowed) throw new ModelBudgetExceededError('Root work budget limit reached', reservation.dimension)
      const remaining = Date.parse(reservation.deadlineAt) - Date.now()
      if (remaining <= 0) throw new ModelBudgetExceededError('Root work execution time exhausted', 'deadline')
      calls++; tokens += input + output; cost += reservedCost
      const rootTimeout = AbortSignal.timeout(Math.min(2_147_483_647, remaining))
      const signal = AbortSignal.any([logicalSignal, rootTimeout])
      const began = performance.now()
      let result: T | undefined, failure: unknown
      const diagnostics: Record<string, unknown> = {providerNotStarted:true}
      const admit=memoryVersion ? async () => {
        signal.throwIfAborted()
        // Same call id, already reserved: the store only validates the server-owned
        // context proof in a short transaction. It cannot charge or issue again.
        const admitted=await host.reserveModelCall(work,callId,{...reserved,memoryAdmission:true})
        if (!admitted.allowed) throw new ModelBudgetExceededError('Root work budget limit reached',admitted.dimension)
        if (Date.parse(admitted.deadlineAt)<=Date.now()) throw new ModelBudgetExceededError('Root work execution time exhausted','deadline')
      } : undefined
      try {
        await emit?.({
          kind: 'model.request.started', stage: 'started', visibility: 'internal',
          data: { callId, logicalCallId, purpose, model: callModel.modelId ?? 'unknown',
            ...(request.prompt ? { prompt: request.prompt } : {}), ...(instructionsSha256 ? { instructionsSha256 } : {}) } })
        delete diagnostics['providerNotStarted']
        result = await abortable(operation(signal, callId, diagnostics,callModel,admit), signal)
      } catch (error) { failure = error }
      const classifiedFailure = failure ? modelFailure(failure, request.signal?.aborted) : undefined
      const usage = diagnostics['providerNotStarted'] ? {available:true,inputTokens:0,outputTokens:0}
        : result?.usage ?? (failure instanceof ModelDriverError ? failure.diagnostics.usage : undefined)
      const inputTokens = usage?.available ? usage.inputTokens : input
      const outputTokens = usage?.available ? usage.outputTokens : output
      const costMicros = Math.ceil((inputTokens * limits.inputCostMicrosPerMillion + outputTokens * limits.outputCostMicrosPerMillion) / 1_000_000)
      tokens += inputTokens + outputTokens - input - output; cost += costMicros - reservedCost
      const observation: ModelCallObservation = {
        ...(request.prompt ? { prompt: request.prompt } : {}), ...(instructionsSha256 ? { instructionsSha256 } : {}),
        callId, ...(attempt > 1 ? { logicalCallId } : {}), purpose,
        workId: work.id, tenantId: work.tenantId, agentId: work.agentId, sessionId: work.sessionId,
        ...(work.threadId !== undefined ? { threadId: work.threadId } : {}), ...(work.principalId ? { principalId: work.principalId } : {}),
        model: result?.model ?? callModel.modelId ?? 'unknown', usage: usage?.available ? usage : { available: false, inputTokens, outputTokens },
        cost: { amountMicros: costMicros, usage: usage?.available ? 'measured' : 'estimated', pricing: modelPricing(limits) },
        latencyMs: performance.now() - began, status: result ? 'succeeded' : 'failed',
        ...(typeof diagnostics['providerFirstContentMs'] === 'number' ? { firstContentMs: diagnostics['providerFirstContentMs'] } : {}),
        ...(callModel.configurationFingerprint ? { configurationFingerprint: callModel.configurationFingerprint } : {}),
        attempt, elapsedMs: performance.now() - logicalBegan,
        ...(classifiedFailure ? { error: `Model request failed (${classifiedFailure.category})`, failure: classifiedFailure } : {}),
      }
      // A completed provider request must be settled even after cancellation or lease loss.
      await host.recordModelUsage(work, callId, { inputTokens, outputTokens, costMicros }, observation)
      // Usage remains durable if the old lease can no longer emit telemetry.
      if (!request.signal?.aborted) await emit?.({ kind: 'model.request.finished', stage: result ? 'completed' : 'failed', visibility: 'internal', data: { ...observation } })
      if (result) return { ...result, callId, logicalCallId, ...(Object.keys(diagnostics).length ? {
        diagnostics: { ...('diagnostics' in result ? result.diagnostics as Record<string, unknown> : {}), ...diagnostics },
      } : {}) }
      // Admission, publication and cancellation gates are not provider failures:
      // settle the one reservation but never retry/fallback past a rejected gate.
      if (signal.aborted) throw deadlineFailure(rootTimeout, signal)
      if (diagnostics['providerNotStarted']) throw failure
      if (attempt >= recovery.maxAttempts) throw failure
      if (fallback && !routed && classifiedFailure && ['authorization','quota','circuit_open','network','timeout','unavailable','rate_limit'].includes(classifiedFailure.category)) {
        callModel = fallback.model
        routed = true
        continue
      }
      if (!classifiedFailure?.retryable) throw failure
      const backoff = Math.max(classifiedFailure.retryAfterMs ?? 0, Math.floor(Math.random() * Math.min(2000, 250 * 2 ** (attempt - 1))))
      // Retry-After is a minimum; if it cannot fit, stop rather than retry early.
      if (backoff >= Math.min(remaining, recovery.totalTimeoutMs - (performance.now() - logicalBegan))) throw failure
      await delay(backoff, undefined, { signal: logicalSignal }).catch(error => {
        throw logicalSignal.aborted ? deadlineFailure() : error
      })
    }
  }
  return { invoke, nextCallId: () => `${work.id}:${work.fence}:${namespace}:${sequence + 1}` }
}

export function executionModel(host: Pick<HostPort, 'reserveModelCall' | 'recordModelUsage'>, source: ModelDriver, work: WorkItem,
  limits: Required<RootModelBudgetOptions>,
  emit?: (event: Omit<RunEvent, 'runId' | 'seq'>) => Promise<unknown>, namespace = 'model', approvedFallback?: ApprovedModelFallback,
  memoryAdmission?: () => number | boolean | undefined): ModelDriver {
  const model = source.singleAttempt?.() ?? source
  const secondary = approvedFallback?.model.singleAttempt?.() ?? approvedFallback?.model
  if (approvedFallback) {
    if (typeof approvedFallback.authorize !== 'function'
      || approvedFallback.inputCostMicrosPerMillion !== limits.inputCostMicrosPerMillion
      || approvedFallback.outputCostMicrosPerMillion !== limits.outputCostMicrosPerMillion) throw new Error('fallback route requires matching approved pricing and current authorization')
    const primary = modelProfile(model), profile = secondary?.profile
    if (!profile || secondary!.previewFormat !== model.previewFormat || secondary!.publicTextProtocol !== model.publicTextProtocol
      || ['toolCalls','jsonObject','parallelTools'].some(key => primary[key as 'toolCalls'] && !profile[key as 'toolCalls'])) {
      throw new Error('fallback route lacks compatible verified model capabilities')
    }
  }
  const admission = namespace !== 'fast-model' && executionClassOf(work) === 'operation' ? 'background' as const : 'foreground' as const
  const { invoke, nextCallId } = modelExecution(host, model, work, limits, emit, namespace,memoryAdmission)
  const admittedStart = <T>(selected: ModelDriver,signal: AbortSignal,diagnostics: Record<string,unknown>,
    admit: (()=>Promise<void>)|undefined,start: (beforeProvider?:()=>void|Promise<void>)=>Promise<T>) => {
    diagnostics['providerNotStarted']=true
    const ready=()=>{ signal.throwIfAborted(); delete diagnostics['providerNotStarted'] }
    // ResourceQuota must obtain capacity before linearizing final admission.
    if (selected.deferredAdmission) return start(()=>admit ? admit().then(ready) : ready())
    const send=()=>{ ready(); return start() }
    return admit ? admit().then(send) : send()
  }
  const check = ({ prompt: _prompt, signal: _signal, ...input }: { prompt?: PromptManifest; signal?: AbortSignal | undefined }, includeProtocol=false) => {
    if (!fitsModel(model, input, includeProtocol)) throw new ModelContextBudgetError()
  }
  const route = (purpose: ModelCallObservation['purpose'], { prompt: _prompt,signal: _signal,...input }: { prompt?: PromptManifest; signal?: AbortSignal | undefined }) => secondary ? {
    model: secondary,
    authorize: async (signal: AbortSignal) => {
      if (!fitsModel(secondary,input,purpose==='agent-turn')) throw new ModelContextBudgetError()
      const { leaseToken: _token,...identity } = work
      await approvedFallback!.authorize({ work: identity,purpose,signal })
    },
  } : undefined
  return {
    ...(model.previewFormat ? { previewFormat: model.previewFormat } : {}),
    ...(model.publicTextProtocol ? { publicTextProtocol: model.publicTextProtocol } : {}),
    nextCallId,
    ...(model.modelId === undefined ? {} : { modelId: model.modelId }),
    ...(model.configurationFingerprint === undefined ? {} : { configurationFingerprint: model.configurationFingerprint }),
    profile: modelProfile(model),
    ...(model.countTokens ? { countTokens: model.countTokens.bind(model) } : {}),
    ...(model.contextWindowTokens === undefined ? {} : { contextWindowTokens: model.contextWindowTokens }),
    ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
    ...(model.maxThinkingTokens === undefined ? {} : { maxThinkingTokens: model.maxThinkingTokens }),
    ...(model.toolDefinitionTokens === undefined ? {} : { toolDefinitionTokens: model.toolDefinitionTokens }),
    ...(model.protocolTokens === undefined ? {} : { protocolTokens: model.protocolTokens }),
    run: request => {
      if (request.purpose === 'approval-explanation' && (request.tools?.length || request.codeExecution !== 'disabled')) {
        throw new Error('approval explanations cannot execute tools')
      }
      check(request,true)
      return invoke('agent-turn', request, (signal, callId, diagnostics,selected,admit) => {
        diagnostics['providerNotStarted']=true
        const gate=request.onAttempt?.(callId)
        const start=()=>admittedStart(selected as ModelDriver,signal,diagnostics,admit,beforeProvider=>{
        const began = performance.now()
        let firstTextMs: number | undefined
        let active = true
        const result = (selected as ModelDriver).run({ ...request, admission, signal, beforeProvider, onTextDelta: (delta,metadata) => {
            if (!active || signal.aborted) return
            if (delta) firstTextMs ??= performance.now() - began
            return request.onTextDelta?.(delta,metadata)
          } })
        const finished = () => {
          active = false
          diagnostics['providerDurationMs'] = performance.now() - began
          if (firstTextMs !== undefined) diagnostics['providerFirstContentMs'] = firstTextMs
        }
        void result.then(finished, finished)
        return result
        })
        // Preserve synchronous/no-hook timing; finish publication before final admission.
        return gate && typeof gate.then === 'function' ? gate.then(start) : start()
      },model,route('agent-turn',request))
    },
    structured: request => {
      check(request)
      return invoke('structured', request, (signal,_id,diagnostics,selected,admit) =>
        admittedStart(selected as ModelDriver,signal,diagnostics,admit,beforeProvider=>(selected as ModelDriver).structured({ ...request, admission, signal,beforeProvider })),model,route('structured',request))
    },
    compact: request => {
      const compiled = { ...request, instructions: COMPACTION_PROMPT.instructions, prompt: COMPACTION_PROMPT.manifest }
      check(compiled)
      return invoke('compaction', compiled, (signal,_id,diagnostics,selected,admit) =>
        admittedStart(selected as ModelDriver,signal,diagnostics,admit,beforeProvider=>(selected as ModelDriver).compact({ ...compiled,
          admission: request.admission === 'background' ? 'background' : admission, signal,beforeProvider })),model,route('compaction',compiled))
    },
  }
}
