import { publicPurposeError } from './public-purpose.js'
import type { ModelProtocolDetail } from '../errors.js'

/** The explicit no-JSON-with-tools profile may emit untyped tool prose. Only
 * letter-led plain prose is a candidate; JSON/markup/framing stays strict.
 * Nothing from this channel acquires a public purpose or enters history. */
export class ToolCompanionBoundary {
  private mode: 'undecided' | 'structured' | 'companion' = 'undecided'
  private prefix = ''
  private size = 0
  get unpublished() { return this.mode === 'companion' }
  push(chunk: string): string | null {
    this.size += chunk.length
    if (this.size > 256_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(chunk)) throw publicPurposeError()
    if (this.mode === 'undecided') {
      this.prefix += chunk
      const first = this.prefix.trimStart()
      if (this.prefix.length - first.length > 4096) throw publicPurposeError()
      if (!first) { if (this.prefix.length > 4096) throw publicPurposeError(); return null }
      this.mode = /^\p{L}/u.test(first) ? 'companion' : 'structured'
      chunk = this.prefix
      this.prefix = ''
    }
    return this.mode === 'companion' ? null : chunk
  }
}

export const companionHasJsonFraming = (text: string): boolean => /^\s*(?:null|true|false)(?![\p{L}\p{N}_])/u.test(text)

export function companionIdentityFailure(input: {
  text: string
  calls: Map<number, { id: string; name: string; arguments: string }>
  finishReasons: string[]; malformed?: boolean
}, exposed: readonly string[], parallel: boolean): ModelProtocolDetail | undefined {
  if (companionHasJsonFraming(input.text)
    || input.malformed || input.finishReasons.length !== 1 || input.finishReasons[0] !== 'tool_calls'
    || !input.calls.size || !parallel && input.calls.size !== 1) return input.malformed?'tool_metadata_invalid':'tool_batch_invalid'
  const identities = new Set<string>()
  for (const [index, call] of input.calls) {
    if (!Number.isSafeInteger(index) || index < 0) return 'tool_index_invalid'
    if (!call.id || call.id.trim() !== call.id) return 'tool_id_invalid'
    if (identities.has(call.id)) return 'tool_id_duplicate'
    if (!exposed.includes(call.name)) return 'tool_name_unknown'
    identities.add(call.id)
  }
  return undefined
}

export function completeCompanionIdentity(input:Parameters<typeof companionIdentityFailure>[0],exposed:readonly string[],parallel:boolean):boolean {
  return companionIdentityFailure(input,exposed,parallel)===undefined
}

export function completeCompanionTurn(input: Parameters<typeof completeCompanionIdentity>[0], exposed: readonly string[], parallel: boolean): boolean {
  if (!completeCompanionIdentity(input, exposed, parallel)) return false
  for (const call of input.calls.values()) {
    try {
      const args: unknown = JSON.parse(call.arguments)
      if (!args || typeof args !== 'object' || Array.isArray(args)) return false
    } catch { return false }
  }
  return true
}
