import { publicPurposeError } from './public-purpose.js'

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

export function completeCompanionTurn(input: {
  text: string
  calls: Map<number, { id: string; name: string; arguments: string }>
  finishReasons: string[]; malformed?: boolean
}, exposed: readonly string[], parallel: boolean): boolean {
  if (/^\s*(?:null|true|false)(?![\p{L}\p{N}_])/u.test(input.text)
    || input.malformed || input.finishReasons.length !== 1 || input.finishReasons[0] !== 'tool_calls'
    || !input.calls.size || !parallel && input.calls.size !== 1) return false
  const identities = new Set<string>()
  for (const [index, call] of input.calls) {
    if (!Number.isSafeInteger(index) || index < 0 || !call.id || call.id.trim() !== call.id
      || identities.has(call.id) || !exposed.includes(call.name)) return false
    identities.add(call.id)
    try {
      const args: unknown = JSON.parse(call.arguments)
      if (!args || typeof args !== 'object' || Array.isArray(args)) return false
    } catch { return false }
  }
  return true
}
