import { PublicPurposeParser, publicPurposeError } from '../model/public-purpose.js'
import type { ModelItem } from './types.js'
import type { MemorySources } from '../memory/history.js'

export const PUBLIC_ANSWER_TOOL_NAME = 'public_answer'
export type PublicAnswerCall = Extract<ModelItem, { type: 'function_call' }> & { name: typeof PUBLIC_ANSWER_TOOL_NAME }
/** Protocol acknowledgement only. This is not a business receipt or an outcome. */
export const PUBLIC_ANSWER_ACK = '{"status":"public_message_recorded"}'

export function decodePublicAnswerCall(value: PublicAnswerCall) {
  if (!value || value.type !== 'function_call' || value.name !== PUBLIC_ANSWER_TOOL_NAME
    || typeof value.callId !== 'string' || !value.callId || value.callId.trim() !== value.callId || value.callId.length > 256
    || typeof value.arguments !== 'string' || value.arguments.length > 256_000
    || Object.keys(value).some(key => !['type', 'callId', 'name', 'arguments'].includes(key))) throw publicPurposeError()
  const parser = new PublicPurposeParser('purpose-json-v3')
  parser.push(value.arguments); parser.finish()
  const text = (JSON.parse(value.arguments) as { answer: string | null }).answer
  if (!parser.operation || parser.outcome === undefined || parser.outcome === null && (text === null || !text.trim())) throw publicPurposeError()
  return { text, operation: parser.operation, outcome: parser.outcome }
}

export function publicAnswerHistory(call: PublicAnswerCall, memorySources: MemorySources): ModelItem[] {
  decodePublicAnswerCall(call)
  return [ { ...call, memorySources }, { type: 'function_call_output', callId: call.callId, output: PUBLIC_ANSWER_ACK, memorySources } ]
}
