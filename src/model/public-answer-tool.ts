import { tool } from '@langchain/core/tools'
import { convertToOpenAITool } from '@langchain/core/utils/function_calling'
import { PUBLIC_ANSWER_TOOL_NAME } from '../protocol/public-answer-call.js'

/** OutputToolBinding: use the actual upstream schema adapter, never its executor.
 * The host's parser/seal/outcome transaction is the only implementation. */
export const PUBLIC_ANSWER_TOOL = convertToOpenAITool(tool(() => {
  throw new Error('public_answer is a protocol output binding, not an executable tool')
}, {
  name: PUBLIC_ANSWER_TOOL_NAME,
  description: 'Publish public answer text or finish the accumulated answer with its outcome. This output binding is the single native call for its turn.',
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      operation: { type: 'object', additionalProperties: false, properties: {
        kind: { type: 'string', enum: ['append', 'replace'] },
        supersedes: { type: 'array', maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 1000 } },
      }, required: ['kind', 'supersedes'] },
      commentary: { type: 'string' },
      answer: { type: ['string', 'null'] },
      outcome: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', enum: ['satisfied', 'partial', 'blocked'] },
        gaps: { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 1000 } },
      }, required: ['status', 'gaps'] }] },
    }, required: ['operation', 'answer', 'outcome'],
  },
}))

export const PUBLIC_ANSWER_TOOL_INSTRUCTIONS = `Public output wire contract (purpose-json-v3; publicAnswerTool native-v1):
Use one native call per turn: public_answer for user-facing content, or a business tool with its exposed arguments. Assistant content and reasoning are private.
public_answer arguments are operation, optional commentary, answer, outcome. operation is {kind:"append",supersedes:[]} for new text, or {kind:"replace",supersedes:[active source IDs]} for a revision. Append text includes its own spacing; replacements become active after delivery validation.
answer is substantive public content; optional commentary is concise public status. outcome:null records a nonempty intermediate answer and continues the task.
A terminal outcome has {status:"satisfied"|"partial"|"blocked",gaps:[...]}. satisfied represents the full delivered result with empty gaps; partial and blocked describe remaining gaps. A terminal answer may be null when sealed sources already contain the answer, or add the remaining content.
Choose a business tool when more evidence or an action is needed. A simple answer can finish with one public_answer. The protocol acknowledgement confirms that a public message was recorded; business results and delivery have their own receipts.`
