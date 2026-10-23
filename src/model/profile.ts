import type { ModelDriver } from './driver.js'

export type ModelPurpose = 'execute' | 'content-review' | 'compaction' | 'memory-synthesis' | 'approval-explanation'

/** Describes configured, tested provider features; API compatibility is not a capability test. */
export interface ModelProfile {
  id: string
  contextWindowTokens: number
  maxOutputTokens: number
  maxThinkingTokens: number
  toolCalls: boolean
  jsonObject: boolean
  /** JSON response mode alongside native tools; omitted means supported for compatibility. */
  jsonObjectWithTools?: boolean
  parallelTools: boolean
}

export function modelProfile(model: ModelDriver): ModelProfile {
  return model.profile ?? { id: model.modelId ?? 'unknown', contextWindowTokens: model.contextWindowTokens ?? 128_000,
    maxOutputTokens: model.maxOutputTokens ?? 8192, maxThinkingTokens: model.maxThinkingTokens ?? 0,
    toolCalls: true, jsonObject: true, parallelTools: true }
}

/** The default remains a conservative UTF-8 bound. Hosts can supply a tested tokenizer. */
export function inputTokens(model: Pick<ModelDriver, 'countTokens' | 'protocolTokens' | 'generationInputTokens'>, input: unknown, includeProtocol = false): number {
  const text = JSON.stringify(input)
  const count = model.countTokens ? model.countTokens(text) : Buffer.byteLength(text)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid model token estimate')
  const protocol=includeProtocol?(model.protocolTokens??0):0
  if(!Number.isSafeInteger(protocol)||protocol<0)throw new Error('invalid protocol token estimate')
  let wire: number | undefined
  if (includeProtocol && model.generationInputTokens && input && typeof input === 'object'
    && typeof Reflect.get(input, 'instructions') === 'string' && Array.isArray(Reflect.get(input, 'items'))) {
    wire = model.generationInputTokens(input as Parameters<NonNullable<ModelDriver['generationInputTokens']>>[0])
    if (wire !== undefined && (!Number.isSafeInteger(wire) || wire < 0)) throw new Error('invalid generation wire token estimate')
  }
  return Math.max(count+protocol, wire ?? 0)
}

export function fitsModel(model: ModelDriver, input: unknown, includeProtocol = false): boolean {
  const profile = modelProfile(model)
  return inputTokens(model, input, includeProtocol) + profile.maxOutputTokens + profile.maxThinkingTokens + 512 <= Math.floor(profile.contextWindowTokens * 0.9)
}
