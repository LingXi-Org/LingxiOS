import type { PublicTextProtocol } from '../model/outcome-declaration.js'
import type { ModelDiagnostics } from '../errors.js'

/** Only fixed local contract facts enter a correction, never a raw provider body. */
export function modelProtocolCorrection(diagnostics:ModelDiagnostics,codeExecution:'enabled'|'disabled',protocol:PublicTextProtocol='purpose-json-v1'):
  {category:'response_protocol'|'tool_protocol';content:string} {
  const execution=codeExecution==='enabled'
    ? 'Use only exposed native tools or an allowed ipython call when needed.'
    : 'Python execution is disabled for this request. Use only exposed native tools when needed.'
  const code=diagnostics.protocolCode
  if(code==='native_envelope_invalid'||code==='terminal_outcome_required'||code==='public_text_invalid'||code==='public_text_incomplete'||code==='public_text_answer_required'){
    const failure=code==='native_envelope_invalid'
      ? 'The previous native-tool response did not satisfy the required public-output envelope. Its business action was not dispatched.'
      :code==='terminal_outcome_required'
        ? 'The previous no-tool response used a null outcome. A terminal response requires an explicit outcome declaration.'
        :code==='public_text_answer_required'
      ? 'The previous response lacked substantive answer text or a legal null terminal answer backed by sealed sources. '
      :code==='public_text_incomplete'
        ? 'The previous public response ended before the complete JSON object was closed.'
        : 'The previous public response violated the required JSON field order, string encoding, or framing.'
    return {category:'response_protocol',content:`Protocol correction: ${failure}
Continue the current active trust=request blocks and their revisions. Historical requests are observations. Existing receipts remain the record of completed or uncertain actions.
Use the ${protocol} contract supplied by the trusted model driver for the current output channel and terminal status.
${execution}`}
  }
  if(code==='response_empty')return {category:'response_protocol',content:`Protocol correction: the previous response contained neither an answer nor a tool call. Provide the substantive answer or an exposed native tool call needed to obtain it. Existing receipts remain the record of completed or uncertain actions. ${execution}`}
  return {category:'tool_protocol',content:`Protocol correction: the previous response violated the tool protocol. Reply again with a valid exposed native tool call or the substantive answer. Existing receipts remain the record of completed or uncertain actions. ${execution}`}
}
