import type { WorkItem } from '../protocol/types.js'
import type { ExecutionStep } from '../control-plane/steps.js'
import type { ToolDefinition } from '../tools/catalog.js'

export type ResponsePolicy = 'deep' | 'auto'
export type ResponseProfile = 'fast' | 'deep'

export function responseProfile(policy: ResponsePolicy | undefined, work: Omit<WorkItem, 'leaseToken'>,
  steps: readonly ExecutionStep[], requestVersion: number): ResponseProfile {
  return policy === 'auto' && work.kind === 'turn' && work.lane === 'interactive' && !work.conversation?.internal
    && !work.meta?.['delegation'] && !work.meta?.['parentWorkId']
    && !(Array.isArray(work.meta?.['attachments']) && work.meta['attachments'].length)
    && !steps.some(step => step.requestVersion === requestVersion
      && !['runtime.binding', 'runtime.checkpoint'].includes(step.kind)) ? 'fast' : 'deep'
}

export const RESPONSE_UPGRADE: ToolDefinition = {
  name: 'response__upgrade', action: 'response.upgrade', effect: 'read', approval: false,
  description: 'Switch this request permanently to deep reasoning and the full authorized context and tools. Required for mathematical derivation, complex code, source-dependent answers, attachments, external operations, or any uncertain task needing verification. Call before answering; do not invent missing context.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
}
