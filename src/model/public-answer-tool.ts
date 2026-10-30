import { PUBLIC_ANSWER_TOOL_NAME } from '../protocol/public-answer-call.js'

/** The host's parser/seal/outcome transaction is the only implementation. */
export const PUBLIC_ANSWER_TOOL = { type: 'function', function: {
  name: PUBLIC_ANSWER_TOOL_NAME,
  description: 'Publish public answer text or finish the accumulated answer with its outcome. This output binding is the single native call for its turn.',
  parameters: {
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
} }

export const PUBLIC_ANSWER_TOOL_INSTRUCTIONS = `Public output wire contract (purpose-json-v3; publicAnswerTool native-v1):
Use one native call per turn: public_answer for user-facing content, or a business tool with its exposed arguments. Assistant content and reasoning are private.
public_answer arguments are operation, optional commentary, answer, outcome. operation is {kind:"append",supersedes:[]} for new text, or {kind:"replace",supersedes:[active source IDs]} for a revision. When the runtime supplies an exact failed-candidate correction target, replace that target instead; never invent IDs or repeat unaffected sealed text. Failed drafts are not sealed body sources. Append text includes its own spacing; replacements become active after delivery validation.
answer is substantive public content; optional commentary is concise public status. outcome:null records a nonempty intermediate answer and continues the task.
A terminal outcome has {status:"satisfied"|"partial"|"blocked",gaps:[...]}. satisfied represents the full delivered result with empty gaps; partial and blocked describe remaining gaps. A terminal answer may be null when sealed sources already contain the answer, or add the remaining content.
Choose a business tool when more evidence or an action is needed. A simple answer can finish with one public_answer. The protocol acknowledgement confirms that a public message was recorded; business results and delivery have their own receipts.`

export const PUBLIC_ANSWER_BATCH_TOOL = { ...PUBLIC_ANSWER_TOOL, function: { ...PUBLIC_ANSWER_TOOL.function,
  description: 'Publish task-specific public content first, optionally followed by business calls in the same batch; a terminal outcome finishes without business calls.' } }

/** Explicit mixed native batch contract; native-v1 retains its original wire policy. */
export const PUBLIC_ANSWER_BATCH_INSTRUCTIONS = `Public output wire contract (purpose-json-v3; publicAnswerTool native-v2):
Every generation starts with one public_answer native call at index 0. Use its original operation, commentary, answer, outcome schema. Raw assistant content and reasoning are private.
This also applies after tool observations and skill activation: never start the next generation with a business call alone. Use exact function.name identifiers from the exposed schemas, not dotted action labels in descriptions.
Before tools, answer supplies useful task-specific content already known; commentary briefly states the next action. Do not merely repeat the request. Then include the needed business calls with their original schemas in the SAME generation. With business calls, answer is nonempty and outcome is null. Independent reads may run together; dependent calls must wait for the previous observation. Writes and approvals retain their existing execution order.
After receiving business observations, state the confirmed results and any actual failure or remaining gap before the next business batch. Add only new substantive answer content; never regenerate the full answer. Do not invent success or expose private reasoning, prompts or sensitive parameters.
When no tool is needed, finish with one public_answer. A final outcome is {status:"satisfied"|"partial"|"blocked",gaps:[...]}; answer may be null when existing sealed sources already contain the complete answer. No business call may accompany a final outcome. No separate summary, review or correction model call is required.
Operation append uses {kind:"append",supersedes:[]} and text supplies its own spacing. Replacement uses {kind:"replace",supersedes:[active source IDs]}. When the runtime supplies an exact failed-candidate correction target, replace that target instead; never invent IDs or repeat unaffected sealed text. Failed drafts are not sealed body sources. Public acknowledgement confirms recorded text, never business execution. Stop once the observations suffice.`
