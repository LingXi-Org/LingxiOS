import type { ModelDiagnostics } from '../errors.js'
import { PUBLIC_PURPOSE_INSTRUCTIONS } from '../model/public-purpose.js'

/** Only fixed local contract facts enter a correction, never a raw provider body. */
export function modelProtocolCorrection(diagnostics:ModelDiagnostics,codeExecution:'enabled'|'disabled'):
  {category:'response_protocol'|'tool_protocol';content:string} {
  const execution=codeExecution==='enabled'
    ? 'Use only exposed native tools or an allowed ipython call when needed.'
    : 'Python execution is disabled for this request. Use only exposed native tools when needed.'
  const code=diagnostics.protocolCode
  if(code==='public_text_invalid'||code==='public_text_incomplete'||code==='public_text_answer_required'){
    const failure=code==='public_text_answer_required'
      ? 'The previous response contained no substantive answer and no native tool call. Public commentary alone does not complete the request.'
      :code==='public_text_incomplete'
        ? 'The previous public response ended before the complete JSON object was closed.'
        : 'The previous public response violated the required JSON field order, string encoding, or framing.'
    return {category:'response_protocol',content:`Protocol correction: ${failure}
Reply again for the original request, preserving completed tool results; do not repeat completed or uncertain side effects.
${PUBLIC_PURPOSE_INSTRUCTIONS}
${execution}`}
  }
  if(code==='response_empty')return {category:'response_protocol',content:`Protocol correction: the previous response contained neither an answer nor a tool call. Provide the substantive answer or an exposed native tool call needed to obtain it. Preserve completed tool results and do not repeat completed or uncertain side effects. ${execution}`}
  return {category:'tool_protocol',content:`Protocol correction: the previous response violated the tool protocol. Reply again with a valid exposed native tool call or the substantive answer. Preserve completed tool results and do not repeat completed or uncertain side effects. ${execution}`}
}
