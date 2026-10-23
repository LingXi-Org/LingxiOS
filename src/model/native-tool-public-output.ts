import { createHash } from 'node:crypto'
import { Tokenizer, TokenParser, TokenType, type ParsedTokenInfo } from '@streamparser/json'
import { PublicPurposeParser, publicPurposeError } from './public-purpose.js'
import type { ToolDefinition } from '../tools/catalog.js'

export const NATIVE_TOOL_PUBLIC_OUTPUT_INSTRUCTIONS = `Public output wire contract (purpose-json-v3), native tool public output envelope v1:
All public output objects use exactly these keys IN THIS ORDER:
{"operation":{"kind":"append","supersedes":[]},"commentary":"","answer":"Useful known answer text","outcome":null}.
operation precedes text. append continues the SAME answer message without repeating earlier text. Supply necessary spaces/newlines: segments concatenate exactly, then the full body is trimmed once.
To correct earlier segments, use kind replace and their exact active segment IDs in supersedes. Never invent IDs; replacement remains provisional until delivery validation succeeds.
commentary is optional concise PUBLIC status, never reasoning. answer is only substantive user-facing content, never status or private analysis. Hidden reasoning is never public output.
This profile permits only ONE native call per turn. Its function arguments must contain exactly {"public_output":null,"arguments":<original business arguments>}.
When useful answer content is already known, put the complete public output object above in public_output with outcome:null BEFORE arguments. Otherwise use public_output:null. Do not fabricate content, add a preface round, or add a second reporting call.
The same native call performs the original action; arguments obey its original business schema. Assistant content on a native-tool turn must be omitted. Tool identity remains in native tool_calls, never in text.
When returning NO tool calls, assistant content must be the complete public output object, with outcome:{"status":"satisfied","gaps":[]} or truthful partial/blocked status and nonempty gaps. Do not wrap terminal content in public_output/arguments.
Only declare satisfied when the accumulated requested result was delivered. Do not anticipate tool results, saves or references. This declaration does not replace permissions, receipts or delivery validation.
answer:null is allowed only on a terminal turn finishing an already nonempty sealed answer in the current answer context; otherwise provide substantive answer text. Never replay an already delivered body.
gaps has at most 16 nonempty strings, each at most 1000 characters, 8192 total. satisfied requires [].
No duplicate/extra keys, markdown framing or trailing prose. The envelope is transport encoding, not user-visible JSON. User formatting constrains the answer field. Previously decoded history is not a wire template. Do not add separate review calls.`

const publicOutputSchema = { type: 'object', properties: {
  operation: { type: 'object', properties: { kind: { enum: ['append', 'replace'] },
    supersedes: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 1000 }, maxItems: 128, uniqueItems: true } },
    required: ['kind', 'supersedes'], additionalProperties: false },
  commentary: { type: 'string', description: 'Optional concise public status, never private reasoning.' },
  answer: { type: 'string', description: 'Only substantive useful known answer content, never status or private reasoning.' },
  outcome: { type: 'null' },
}, required: ['operation', 'commentary', 'answer', 'outcome'], additionalProperties: false }

/** An embedded schema is its own resource so # references retain their old root.
 * No reference rewriting, coercion, remote loading or business-schema weakening.
 */
export function wrapNativeToolSchema(schema: Record<string, unknown>): ToolDefinition['parameters'] {
  const dialect = schema['$schema']
  if (dialect !== undefined && !['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft-07/schema',
    'https://json-schema.org/draft/2020-12/schema'].includes(String(dialect))) throw new Error('unsupported trusted tool schema dialect')
  const generatedId = `https://lingxios.invalid/native-tool-schema/${createHash('sha256').update(JSON.stringify(schema)).digest('hex')}`
  const originalId = schema['$id']
  if (originalId !== undefined && typeof originalId !== 'string') throw new Error('invalid trusted schema id')
  const [document, fragment] = (originalId ?? '').split('#')
  // Resolve relative IDs against an isolated document base before embedding.
  // Otherwise Ajv normalizes './dir/tool' when resolving refs but can register
  // the embedded resource under its unnormalized spelling. Nested relative IDs
  // and refs still resolve against the same business document, without rewrite.
  const resourceId = document ? new URL(document, `${generatedId}/`).href : generatedId
  // draft-07 root fragment identifiers are anchors on the original document.
  // Retain that anchor as a sibling alias, without changing business definitions
  // or rewriting any reference inside the original schema.
  if (fragment && dialect === 'https://json-schema.org/draft/2020-12/schema') throw new Error('fragment schema ids are invalid in draft-2020-12')
  const resource = { ...schema, $id: resourceId }
  return { ...(dialect === undefined ? {} : { $schema: dialect }), type: 'object',
    ...(fragment ? { definitions: { businessRootAnchor: { $id: `${resourceId}#${fragment}`, $ref: '#' } } } : {}),
    properties: { public_output: { anyOf: [{ type: 'null' }, publicOutputSchema] }, arguments: resource },
    required: ['public_output', 'arguments'], additionalProperties: false }
}

export function wrapNativeToolArguments(argumentsText: string): string {
  return '{"public_output":null,"arguments":' + argumentsText + '}'
}

/** The dependency owns JSON tokenization/grammar; this bounded state machine
 * only identifies the two envelope members. The original public parser owns
 * public purpose grammar. Raw public bytes are forwarded on EVERY write, even
 * while the tokenizer's answer string token is still partial.
 */
export class NativeToolPublicOutput {
  readonly purpose = new PublicPurposeParser('purpose-json-v3')
  private readonly tokenizer = new Tokenizer({ emitPartialTokens: true })
  private readonly grammar = new TokenParser({ keepStack: false })
  private stage: 'root' | 'key' | 'colon' | 'value' | 'body' | 'separator' | 'done' = 'root'
  private field: 'public_output' | 'arguments' | undefined
  private readonly fields = new Set<string>()
  private depth = 0
  private publicStart: number | undefined
  private publicEnd: number | undefined
  private argsStart: number | undefined
  private argsEnd: number | undefined
  private chunks: Buffer[] = []
  private length = 0
  private pendingSurrogate = ''
  private text = ''
  private finished = false
  private invalid = false
  get operation() { return this.purpose.operation }
  constructor() {
    this.grammar.onValue = () => {}
    this.tokenizer.onToken = token => {
      if (token.partial) return
      this.grammar.write(token)
      this.token(token)
    }
  }
  private token({ token, value, offset }: ParsedTokenInfo) {
    const expect = (type: TokenType, next: typeof this.stage, key?: string) => {
      if (token !== type || key !== undefined && value !== key) throw publicPurposeError()
      this.stage = next
    }
    switch (this.stage) {
      case 'root': expect(TokenType.LEFT_BRACE, 'key'); break
      case 'key':
        if (token !== TokenType.STRING || value !== 'public_output' && value !== 'arguments' || this.fields.has(value)) throw publicPurposeError()
        this.field = value; this.fields.add(value); this.stage = 'colon'; break
      case 'colon': expect(TokenType.COLON, 'value'); break
      case 'value':
        if (this.field === 'public_output' && token === TokenType.NULL) this.stage = 'separator'
        else {
          expect(TokenType.LEFT_BRACE, 'body'); this.depth = 1
          if (this.field === 'public_output') this.publicStart = offset
          else this.argsStart = offset
        }
        break
      case 'body':
        if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) this.depth++
        else if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) {
          if (--this.depth === 0) {
            if (this.field === 'public_output') this.publicEnd = offset + 1
            else this.argsEnd = offset + 1
            this.stage = 'separator'
          }
        }
        break
      case 'separator':
        if (this.fields.size === 2) expect(TokenType.RIGHT_BRACE, 'done')
        else expect(TokenType.COMMA, 'key')
        break
      case 'done': throw publicPurposeError()
    }
  }
  push(chunk: string): ReturnType<PublicPurposeParser['push']> {
    if (this.finished || this.invalid) throw publicPurposeError()
    try {
      chunk = this.pendingSurrogate + chunk
      this.pendingSurrogate = ''
      const last = chunk.charCodeAt(chunk.length - 1)
      if (last >= 0xd800 && last <= 0xdbff) { this.pendingSurrogate = chunk.slice(-1); chunk = chunk.slice(0, -1) }
      if (!chunk) return []
      // Reject unpaired UTF-16 instead of letting Buffer replace it with U+FFFD.
      if (/[\uD800-\uDFFF]/u.test(chunk)) throw publicPurposeError()
      const bytes = Buffer.from(chunk)
      const previousLength = this.length
      this.length += bytes.length
      if (this.length > 16 * 1024 * 1024) throw publicPurposeError()
      this.chunks.push(bytes)
      const wasComplete = this.publicEnd !== undefined
      this.tokenizer.write(bytes)
      const start = Math.max(previousLength, this.publicStart ?? this.length)
      const end = Math.min(this.length, this.publicEnd ?? this.length)
      const parts = start < end ? this.purpose.push(bytes.subarray(start - previousLength, end - previousLength).toString('utf8')) : []
      for (const part of parts) if (part.purpose === 'answer') this.text += part.text
      if (!wasComplete && this.publicEnd !== undefined) {
        this.purpose.finish()
        if (this.purpose.outcome !== null || this.purpose.answerIsNull) throw publicPurposeError()
      }
      return parts
    } catch { this.invalid = true; throw publicPurposeError() }
  }
  finish(): { arguments: string; text: string } {
    if (this.invalid || this.finished || this.pendingSurrogate) throw publicPurposeError()
    try {
      this.tokenizer.end()
      if (this.stage !== 'done' || this.argsStart === undefined || this.argsEnd === undefined) throw publicPurposeError()
      this.finished = true
      return { arguments: Buffer.concat(this.chunks).subarray(this.argsStart, this.argsEnd).toString('utf8'), text: this.text }
    } catch { this.invalid = true; throw publicPurposeError() }
  }
}
