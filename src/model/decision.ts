import { createHash, randomUUID } from 'node:crypto'
import type { ModelUsage } from './driver.js'
import { modelExecution, DEFAULT_MODEL_BUDGET, type RootModelBudgetOptions } from './execution.js'
import type { HostPort } from '../host/port.js'
import type { WorkItem } from '../protocol/types.js'
import { ResourceQuota } from '../resource-quota.js'
import { AgentOSError } from '../errors.js'

export type DecisionQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
export type DecisionAnswer = { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, string> }
  | { type: 'noul'; noul: number }
export interface DecisionRequest { purpose: string; version: string; state: unknown; questions: Record<string, DecisionQuestion>; rejectChoices?: Record<string, string[]>; signal?: AbortSignal | undefined }
export interface DecisionResult { model: string; answers: Record<string, DecisionAnswer>; usage: ModelUsage; callId?: string }
export interface DecisionSummary {
  version: '2'; purpose: string; questionVersion: string; inputHash: string; model: string;
  mode: DecisionMode; outcome: 'adopted' | 'uncertain' | 'failed' | 'shadow';
  callId?: string; answers: Record<string, string | number>; fallback?: 'generation' | 'original';
}
export type DecisionMode = 'off' | 'shadow' | 'active'
export interface DecisionDriver {
  readonly modelId: string
  readonly configurationFingerprint: string
  readonly inputCostMicrosPerMillion: number
  mode(purpose: string): DecisionMode
  decide(request: DecisionRequest): Promise<DecisionResult>
  threshold?(purpose: string): number
  recordDecision?(summary: DecisionSummary): Promise<void>
  recordFallback?(purpose: string, value: Record<string, string | number | boolean>): Promise<void>
}
export interface JevOptions {
  apiKey: string
  model?: string
  mode?: DecisionMode
  modes?: Record<string, DecisionMode>
  thresholds?: Record<string, number>
  timeoutMs?: number
  concurrency?: number
  inputCostMicrosPerMillion?: number
  /** Local HTTP fixtures only; production uses the official HTTPS origin. */
  baseUrl?: string
  fetchImpl?: typeof fetch
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const probability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
const keysEqual = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const yesNo = (instructions: string): DecisionQuestion => ({ type: 'choice', instructions,
  criteria: { yes: 'The stated condition is supported by the supplied evidence.', no: 'The stated condition is false.', uncertain: 'Insufficient or contradictory evidence.' } })
export function accepted(answer: DecisionAnswer | undefined, choice = 'yes', threshold = 0.95): boolean {
  return answer?.type === 'choice' && answer.choice === choice && answer.confidence >= threshold
}

/** Lifecycle/storage errors must never become an extra paid fallback. */
export function decisionFallback(error: unknown, signal?: AbortSignal): void {
  signal?.throwIfAborted()
  if (error instanceof AgentOSError) { if (error.code === 'model_context_budget') return; throw error }
  if (!(error instanceof Error) || !/^(jev_|invalid decision |decision (context|request|span|coverage|findings) limit)/.test(error.message)) throw error
}

export async function decideOrFallback(driver: DecisionDriver, request: DecisionRequest,
  fallback: 'generation' | 'original' = 'generation'): Promise<DecisionResult | undefined> {
  const mode = driver.mode(request.purpose)
  if (mode === 'off') return undefined
  const summary: DecisionSummary = { version: '2', purpose: request.purpose, questionVersion: request.version,
    inputHash: hash([request.state, request.questions]), model: driver.modelId, mode, outcome: 'failed', answers: {} }
  let result: DecisionResult | undefined
  try {
    result = await driver.decide(request)
    request.signal?.throwIfAborted()
    if (result.callId) summary.callId = result.callId
    const threshold = driver.threshold?.(request.purpose) ?? 0.95
    const rejected = Object.entries(result.answers).some(([id, a]) => a.type === 'choice' && a.confidence >= threshold && request.rejectChoices?.[id]?.includes(a.choice))
    const uncertain = !rejected && Object.values(result.answers).some(a => a.type === 'noul' || a.confidence < threshold
      || a.type === 'choice' && ['uncertain', 'unknown'].includes(a.choice))
    summary.answers = Object.fromEntries(Object.entries(result.answers).map(([id, a]) => [id, a.type === 'choice' ? a.choice : a.type === 'score' ? a.score : a.noul]))
    summary.outcome = mode === 'shadow' ? 'shadow' : uncertain ? 'uncertain' : 'adopted'
  } catch (error) { decisionFallback(error, request.signal) }
  if (summary.outcome !== 'adopted') summary.fallback = fallback
  // Audit persistence is outside the provider catch: a lost lease or storage error is fatal.
  await driver.recordDecision?.(summary)
  return summary.outcome === 'adopted' ? result : undefined
}

export function validateDecisionRequest(request: DecisionRequest): void {
  if (!/^[a-z][a-z0-9.-]{0,99}$/.test(request.purpose) || !/^[a-zA-Z0-9._-]{1,100}$/.test(request.version)
    || !record(request.questions) || !Object.keys(request.questions).length || Object.keys(request.questions).length > 128
    || request.state === undefined) throw new Error('invalid decision request')
  const stateBytes = Buffer.byteLength(JSON.stringify(request.state))
  for (const [id, question] of Object.entries(request.questions)) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !record(question) || typeof question.instructions !== 'string' || !question.instructions.trim()) throw new Error('invalid decision question')
    if (question.type === 'choice') {
      if (!record(question.criteria) || Object.keys(question.criteria).length < 2 || Object.keys(question.criteria).length > 255
        || Object.entries(question.criteria).some(([key, value]) => !key || typeof value !== 'string')) throw new Error('invalid decision choices')
    } else if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10
        || question.criteria.some(value => typeof value !== 'string' || !value.trim())) throw new Error('invalid decision rubric')
    } else if (question.type !== 'noul') throw new Error('invalid decision question type')
    else if (question.criteria !== undefined && (!record(question.criteria) || !keysEqual(question.criteria, ['true', 'false'])
      || Object.values(question.criteria).some(value => typeof value !== 'string' || !value.trim()))) throw new Error('invalid decision boolean criteria')
    // Conservative UTF-8 upper bound; never truncate requirements or authoritative evidence.
    if (stateBytes + Buffer.byteLength(JSON.stringify(question)) > 30_000) throw new Error('decision context limit exceeded')
  }
  if (Buffer.byteLength(JSON.stringify({ state: request.state, questions: request.questions })) > 60_000) throw new Error('decision request limit exceeded')
}

export function parseDecisionResult(value: unknown, questions: Record<string, DecisionQuestion>, model: string): DecisionResult {
  if (!record(value) || value['model'] !== model || !record(value['answers']) || !keysEqual(value['answers'], Object.keys(questions))
    || !record(value['usage']) || !Number.isSafeInteger(value['usage']['input_tokens']) || Number(value['usage']['input_tokens']) < 0
    || !Number.isSafeInteger(value['usage']['output_tokens']) || Number(value['usage']['output_tokens']) < 0) throw new Error('invalid decision response or usage')
  for (const [id, question] of Object.entries(questions)) {
    const answer = value['answers'][id]
    if (!record(answer) || answer['type'] !== question.type) throw new Error('invalid decision answer type')
    if (question.type === 'noul') {
      if (!probability(answer['noul'])) throw new Error('invalid decision probability')
      continue
    }
    const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index))
    if (!probability(answer['confidence']) || !record(answer['probabilities']) || !keysEqual(answer['probabilities'], keys)
      || !Object.values(answer['probabilities']).every(probability)
      || Math.abs(Object.values(answer['probabilities']).reduce<number>((sum, p) => sum + Number(p), 0) - 1) > 0.02) throw new Error('invalid decision distribution')
    if (question.type === 'choice') {
      if (typeof answer['choice'] !== 'string' || !keys.includes(answer['choice'])
        || Number(answer['probabilities'][answer['choice']]) + 0.001 < Math.max(...Object.values(answer['probabilities']).map(Number))) throw new Error('invalid decision choice')
    } else if (typeof answer['score'] !== 'number' || !Number.isFinite(answer['score']) || answer['score'] < 0 || answer['score'] > keys.length - 1
      || !record(answer['legend']) || !keysEqual(answer['legend'], keys)
      || keys.some(key => answer['legend'] && (answer['legend'] as Record<string, unknown>)[key] !== question.criteria[Number(key)])) throw new Error('invalid decision score')
  }
  return { model, answers: value['answers'] as Record<string, DecisionAnswer>,
    usage: { available: true, inputTokens: Number(value['usage']['input_tokens']), outputTokens: Number(value['usage']['output_tokens']) } }
}

export class JevClient implements DecisionDriver {
  readonly modelId: string
  readonly configurationFingerprint: string
  readonly inputCostMicrosPerMillion: number
  private readonly quota: ResourceQuota
  private readonly url: string
  constructor(private readonly options: JevOptions) {
    this.modelId = options.model ?? 'jev-1.13.0'
    this.inputCostMicrosPerMillion = options.inputCostMicrosPerMillion ?? 42_000
    const base = new URL(options.baseUrl ?? 'https://api.typesafe.ai/v1')
    if (!options.apiKey?.trim() || !/^jev-\d+\.\d+\.\d+$/.test(this.modelId)
      || !Number.isSafeInteger(this.inputCostMicrosPerMillion) || this.inputCostMicrosPerMillion < 0
      || !Number.isSafeInteger(options.timeoutMs ?? 5000) || (options.timeoutMs ?? 5000) < 1 || (options.timeoutMs ?? 5000) > 120_000
      || [options.mode ?? 'active', ...Object.values(options.modes ?? {})].some(mode => !['off', 'shadow', 'active'].includes(mode))
      || Object.values(options.thresholds ?? {}).some(value => !probability(value))
      || base.username || base.password || base.search || base.hash
      || base.origin !== 'https://api.typesafe.ai' && !['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)) throw new Error('invalid Jev configuration')
    this.url = base.href.replace(/\/$/, '') + '/systemone'
    this.quota = new ResourceQuota(options.concurrency ?? 2, 32)
    this.configurationFingerprint = hash({ model: this.modelId, url: this.url, price: this.inputCostMicrosPerMillion,
      mode: options.mode ?? 'active', modes: options.modes ?? {}, thresholds: options.thresholds ?? {}, timeoutMs: options.timeoutMs ?? 5000, contract: 'jev-decisions/2' })
  }
  mode(purpose: string): DecisionMode { return this.options.modes?.[purpose] ?? this.options.mode ?? 'active' }
  threshold(purpose: string): number { return this.options.thresholds?.[purpose] ?? (['memory-relevance', 'knowledge-relevance', 'product-context', 'route-selection'].includes(purpose) ? 0.8 : 0.95) }
  async decide(request: DecisionRequest): Promise<DecisionResult> {
    validateDecisionRequest(request)
    if (this.mode(request.purpose) === 'off') throw new Error('decision purpose is disabled')
    const signal = AbortSignal.any([AbortSignal.timeout(this.options.timeoutMs ?? 5000), ...request.signal ? [request.signal] : []])
    return this.quota.run(async () => {
      let response: Response
      try { response = await (this.options.fetchImpl ?? fetch)(this.url, { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.modelId, state: request.state, questions: request.questions }) }) }
      catch { throw new Error(signal.aborted ? 'jev_request_aborted' : 'jev_connection_failed') }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`jev_http_${response.status}`) }
      const reader = response.body?.getReader()
      if (!reader) throw new Error('jev_empty_response')
      const chunks: Uint8Array[] = []; let bytes = 0
      try {
        for (;;) { const next = await reader.read(); if (next.done) break
          bytes += next.value.byteLength
          if (bytes > 256_000) throw new Error('jev_response_limit_exceeded')
          chunks.push(next.value)
        }
        let value: unknown
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('jev_invalid_json') }
        return parseDecisionResult(value, request.questions, this.modelId)
      } catch (error) {
        request.signal?.throwIfAborted()
        if (error instanceof Error && /^(jev_|invalid decision )/.test(error.message)) throw error
        throw new Error('jev_response_failed')
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    }, signal)
  }
}

/** Uses the same durable root budget and outbox observer as generative calls, at Jev prices. */
export function executionDecision(host: Pick<HostPort, 'reserveModelCall' | 'recordModelUsage'> & Partial<Pick<HostPort, 'saveStep' | 'heartbeat'>>, source: DecisionDriver,
  work: WorkItem, budget: RootModelBudgetOptions = {}): DecisionDriver {
  const { invoke } = modelExecution(host, { modelId: source.modelId, maxOutputTokens: 8192, maxThinkingTokens: 0, toolDefinitionTokens: 0 }, work,
    { ...DEFAULT_MODEL_BUDGET, ...budget, inputCostMicrosPerMillion: source.inputCostMicrosPerMillion, outputCostMicrosPerMillion: 0 },
    undefined, `decision:${randomUUID()}`)
  let requestVersion = 1
  let lastSummary: DecisionSummary | undefined
  return { modelId: source.modelId, configurationFingerprint: source.configurationFingerprint,
    inputCostMicrosPerMillion: source.inputCostMicrosPerMillion, mode: source.mode.bind(source),
    threshold: purpose => source.threshold?.(purpose) ?? 0.95,
    async recordDecision(summary) {
      lastSummary = summary
      await host.saveStep?.(work, { id: `decision:${randomUUID()}`, kind: 'runtime.decision', requestVersion,
        input: { purpose: summary.purpose, inputHash: summary.inputHash }, output: JSON.stringify(summary), artifacts: [] })
      await source.recordDecision?.(summary)
    },
    async recordFallback(purpose, value) {
      if (lastSummary?.purpose !== purpose) return
      await host.saveStep?.(work, { id: `decision-comparison:${randomUUID()}`, kind: 'runtime.decision-comparison', requestVersion,
        input: { inputHash: lastSummary.inputHash, purpose }, output: JSON.stringify({ decision: lastSummary, fallback: value }), artifacts: [] })
    },
    async decide(request) {
      validateDecisionRequest(request)
      if (host.heartbeat) requestVersion = ((await host.heartbeat(work, request.signal)).steer?.length ?? 0) + 1
      const instructions = JSON.stringify({ purpose: request.purpose, version: request.version, questions: request.questions })
      return invoke('decision', { input: request.state, instructions, signal: request.signal,
        decision: { purpose: request.purpose, version: request.version, inputHash: hash([request.state, request.questions]) } }, signal => source.decide({ ...request, signal }))
    } }
}
