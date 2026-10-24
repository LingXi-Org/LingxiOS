import { tool } from '@langchain/core/tools'
import { convertToOpenAITool } from '@langchain/core/utils/function_calling'
import { PUBLIC_ANSWER_TOOL_NAME } from '../protocol/public-answer-call.js'

/** OutputToolBinding: use the actual upstream schema adapter, never its executor.
 * The host's parser/seal/outcome transaction is the only implementation. */
export const PUBLIC_ANSWER_TOOL = convertToOpenAITool(tool(() => {
  throw new Error('public_answer is a protocol output binding, not an executable tool')
}, {
  name: PUBLIC_ANSWER_TOOL_NAME,
  description: 'Publish useful public answer text, or finish the accumulated answer with a truthful outcome. Not a business action. Use this tool alone in its native turn.',
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
Use the native public_answer tool for public answers. Assistant content and reasoning channels remain private and are never public answers. Do not duplicate public text in assistant content.
Its arguments are exactly one JSON object IN THIS ORDER: operation, optional commentary, answer, outcome. Example of encoding only: {"operation":{"kind":"append","supersedes":[]},"answer":"Useful known answer text","outcome":null}.
operation precedes text. append adds only new useful content to the SAME answer; include necessary spaces/newlines yourself. replace names exact currently active source IDs in supersedes; it stays provisional until delivery validation. Never repeat prior text or invent source IDs.
commentary is optional public status, never reasoning. answer contains substantive content grounded in available facts; do not claim a tool succeeded before its result exists.
outcome:null seals a nonempty intermediate answer and continues this execution. Use it only when useful content is already known and work remains, never a status preamble. No introductory call is required.
A terminal public_answer declares outcome with exactly status then gaps: satisfied only for the full delivered result and gaps:[]; partial or blocked require truthful nonempty gaps. Gaps have at most 16 strings, 1000 characters each, 8192 total. This declaration does not bypass authorization, receipts, resources or completion checks.
answer:null is allowed only for a terminal outcome when the current answer-source context already has nonempty sealed text. Otherwise provide substantive answer text. Final output appends only missing results, never replays the accumulated answer.
At most ONE native call is allowed per turn, counting public_answer itself. Never combine it with a business tool or another public_answer. Business tools keep their original exposed arguments. When you need unknown evidence, call the business tool first; do not fabricate a public preface.
A simple question needing no business tool uses one public_answer with the complete answer and terminal outcome in ONE generation. Do not add a judge, router, review or obligatory extra call.
No extra fields, duplicate keys, markdown fences or trailing prose. A protocol acknowledgement means only that the public message was recorded, not that a business action or task succeeded.`
