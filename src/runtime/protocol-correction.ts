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
        ? 'The previous no-tool response used a null outcome. A terminal response requires an explicit truthful outcome declaration; do not assume completion.'
        :code==='public_text_answer_required'
      ? 'The previous response contained no substantive answer and no native tool call. Public commentary alone does not complete the request.'
      :code==='public_text_incomplete'
        ? 'The previous public response ended before the complete JSON object was closed.'
        : 'The previous public response violated the required JSON field order, string encoding, or framing.'
    return {category:'response_protocol',content:`Protocol correction: ${failure}
Reply again for the current active trust=request blocks and their current revisions. Historical requests are observations; do not resume an earlier task unless the current request explicitly asks for it. Preserve completed tool results; do not repeat completed or uncertain side effects.
Follow the ${protocol} public wire contract selected and supplied by the trusted model driver for this turn, including its native-tool and no-tool response branches. Do not substitute a different output schema or channel.
${execution}`}
  }
  if(code==='response_empty')return {category:'response_protocol',content:`Protocol correction: the previous response contained neither an answer nor a tool call. Provide the substantive answer or an exposed native tool call needed to obtain it. Preserve completed tool results and do not repeat completed or uncertain side effects. ${execution}`}
  return {category:'tool_protocol',content:`Protocol correction: the previous response violated the tool protocol. Reply again with a valid exposed native tool call or the substantive answer. Preserve completed tool results and do not repeat completed or uncertain side effects. ${execution}`}
}
