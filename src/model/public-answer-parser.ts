import { JSONParser, TokenType, type ParsedTokenInfo, type ParsedElementInfo } from '@streamparser/json'
import { snapshotPublicTextOperation, type PublicTextOperation } from '../protocol/answer-segments.js'
import type { PublicTextPurpose } from '../protocol/public-text.js'
import { snapshotOutcomeDeclaration, type OutcomeDeclaration } from './outcome-declaration.js'
import { publicPurposeError } from './public-purpose.js'

type Part = { text: string; purpose: PublicTextPurpose }
/** The upstream JSON parser owns tokenization, escaping and grammar. This
 * adapter binds known fields to public purposes, detects duplicate keys and
 * withholds text until the operation is complete. Final native validation and
 * publication still own acceptance/sealing. Used only by public_answer. */
export class PublicAnswerParser {
  private readonly parser = new JSONParser({ emitPartialTokens: true, emitPartialValues: true, keepStack: true })
  private readonly keys = new WeakMap<object, Set<string>>()
  private token: ParsedTokenInfo | undefined
  private readonly text = new Map<PublicTextPurpose, string>()
  private readonly emitted = new Map<PublicTextPurpose, number>()
  private parts: Part[] = []
  private pendingSurrogate = ''
  private size = 0
  private invalid = false
  private finished = false
  private closed = false
  operation: PublicTextOperation | undefined
  outcome: OutcomeDeclaration | null | undefined
  answerIsNull = false
  get answer() { return this.answerIsNull ? null : this.text.get('answer') ?? '' }
  get complete() { return this.closed && !this.invalid }
  constructor() {
    this.parser.onToken = token => { this.token = token }
    this.parser.onValue = value => this.value(value)
  }
  private value(info: ParsedElementInfo) {
    const { value, key, parent, stack, partial } = info
    if (stack.length > 4) throw publicPurposeError()
    // A completed key emits a partial value with no value yet. Inspect that
    // public callback before a duplicate can overwrite the assembled object.
    if (partial && value === undefined && typeof key === 'string' && parent && !Array.isArray(parent)
      && this.token?.token === TokenType.STRING && !this.token.partial) {
      const keys = this.keys.get(parent) ?? new Set<string>()
      if (keys.has(key) || stack.length === 1 && !['operation', 'commentary', 'answer', 'outcome'].includes(key)) throw publicPurposeError()
      keys.add(key); this.keys.set(parent, keys)
    }
    if (stack.length === 1 && (key === 'answer' || key === 'commentary') && value !== undefined) {
      if (value === null && key === 'answer') {
        // The upstream tokenizer also emits null while its literal is incomplete.
        if (!partial) this.answerIsNull = true
      }
      else {
        if (typeof value !== 'string') throw publicPurposeError()
        let safe = value
        const last = safe.charCodeAt(safe.length - 1)
        if (partial && last >= 0xd800 && last <= 0xdbff) safe = safe.slice(0, -1)
        if (/[\uD800-\uDFFF]/u.test(safe) || !safe.startsWith(this.text.get(key) ?? '')) throw publicPurposeError()
        this.text.set(key, safe); this.flush()
      }
    }
    if (!partial && stack.length === 1 && key === 'operation') {
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof Reflect.get(value, 'kind') !== 'string') throw publicPurposeError()
      this.operation = snapshotPublicTextOperation(value); this.flush()
    }
    if (!partial && stack.length === 1 && key === 'outcome') this.outcome = value === null ? null : snapshotOutcomeDeclaration(value)
    if (!partial && stack.length === 0) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || !this.operation || !Object.hasOwn(value, 'answer') || !Object.hasOwn(value, 'outcome')
        || this.outcome === undefined || Object.keys(value).some(field => !['operation', 'commentary', 'answer', 'outcome'].includes(field))) throw publicPurposeError()
      this.closed = true
    }
  }
  private flush() {
    if (!this.operation) return
    for (const [purpose, text] of this.text) {
      const offset = this.emitted.get(purpose) ?? 0
      if (text.length > offset) {
        const delta = text.slice(offset), previous = this.parts.at(-1)
        if (previous?.purpose === purpose) previous.text += delta
        else this.parts.push({ purpose, text: delta })
        this.emitted.set(purpose, text.length)
      }
    }
  }
  push(chunk: string): Part[] {
    if (this.invalid || this.finished) throw publicPurposeError()
    this.parts = []
    try {
      this.size += chunk.length
      if (this.size > 256_000) throw publicPurposeError()
      chunk = this.pendingSurrogate + chunk; this.pendingSurrogate = ''
      const last = chunk.charCodeAt(chunk.length - 1)
      if (last >= 0xd800 && last <= 0xdbff) { this.pendingSurrogate = chunk.slice(-1); chunk = chunk.slice(0, -1) }
      if (/[\uD800-\uDFFF]/u.test(chunk)) throw publicPurposeError()
      if (chunk) this.parser.write(Buffer.from(chunk))
      return this.parts
    } catch { this.invalid = true; throw publicPurposeError() }
  }
  finish() {
    if (this.invalid || this.pendingSurrogate) throw publicPurposeError()
    if (!this.complete) throw publicPurposeError('public_text_incomplete')
    this.finished = true
  }
}
