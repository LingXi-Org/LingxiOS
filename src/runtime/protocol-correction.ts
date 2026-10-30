import type { PublicTextProtocol } from '../model/outcome-declaration.js'
import type { ModelDiagnostics } from '../errors.js'

/** Only fixed local contract facts enter a correction, never a raw provider body. */
export function modelProtocolCorrection(diagnostics:ModelDiagnostics,codeExecution:'enabled'|'disabled',protocol?:PublicTextProtocol):
  {category:'response_protocol'|'tool_protocol';content:string} {
  const execution=codeExecution==='enabled'
    ? 'Use only exposed native tools or an allowed ipython call when needed.'
    : 'Python execution is disabled for this request. Use only exposed native tools when needed.'
  const code=diagnostics.protocolCode
  if(code==='public_answer_first_required'){
    const failure=diagnostics.protocolDetail==='public_answer_missing'?'did not include public_answer'
      :diagnostics.protocolDetail==='public_answer_misordered'?'placed public_answer after a business call'
      :'did not place public_answer at index 0'
    return {category:'response_protocol',content:`Protocol correction: the previous native-v2 batch ${failure}. Its business calls were not dispatched. Start with the first exposed tool schema, public_answer, containing new substantive answer text, operation and outcome:null, then include the needed business calls in the SAME generation using their exact exposed function.name identifiers. Return public_answer first in tool_calls, not assistant prose and not a trailing call. Do not repeat sealed answer text or stop after restating an explanation. If no work remains, use public_answer alone with an honest terminal outcome. Existing receipts remain the record of completed or uncertain actions. ${execution}`}
  }
  const completion=protocol==='purpose-json-v3'
    ? '\nIf the current request is fully answered, declare its terminal outcome in this corrected response; do not add another full-answer round. Use outcome:null only for unfinished work. When sealed sources already contain the answer, finish with answer:null and a terminal outcome; revise their content only with explicit replace and their active source IDs. Never append a restatement of sealed text.'
    : ''
  if(code==='native_envelope_invalid'||code==='terminal_outcome_required'||code==='public_text_invalid'||code==='public_text_incomplete'||code==='public_text_answer_required'){
    const failure=code==='native_envelope_invalid'
      ? 'The previous native-tool response did not satisfy the required public-output envelope. Its business action was not dispatched.'
      :code==='terminal_outcome_required'
        ? 'The previous no-tool response used a null outcome. A terminal response requires an explicit outcome declaration.'
        :code==='public_text_answer_required'
      ? 'The previous response lacked substantive answer text or a legal null terminal answer backed by sealed sources. '
      :code==='public_text_incomplete'
        ? 'The previous public response ended before the complete JSON object was closed.'
        : 'The previous public response violated the required JSON fields, types, string encoding, or framing.'
    return {category:'response_protocol',content:`Protocol correction: ${failure}
Continue the current active trust=request blocks and their revisions. Historical requests are observations. Existing receipts remain the record of completed or uncertain actions.
Use the ${protocol ?? 'configured output'} contract supplied by the trusted model driver for the current output channel and terminal status.
${execution}${completion}`}
  }
  if(code==='response_empty')return {category:'response_protocol',content:`Protocol correction: the previous response contained neither an answer nor a tool call. Provide the substantive answer or an exposed native tool call needed to obtain it. Existing receipts remain the record of completed or uncertain actions. ${execution}${completion}`}
  return {category:'tool_protocol',content:`Protocol correction: the previous response violated the tool protocol. Use exact function.name identifiers from the exposed tool schemas; dotted action labels in descriptions are not callable names. Preserve the public output binding required by the configured contract when calling business tools. Existing receipts remain the record of completed or uncertain actions. ${execution}${completion}`}
}
