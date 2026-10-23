import { parseOutcomeTail, type OutcomeDeclaration, type PublicTextProtocol } from './outcome-declaration.js'
import { ModelDriverError } from '../errors.js'
import type { PublicTextPurpose } from '../protocol/public-text.js'

export const PUBLIC_PURPOSE_INSTRUCTIONS = `Public output wire contract (purpose-json-v1):
Encode assistant content as exactly one JSON object with two string fields IN THIS ORDER:
{"commentary":"","answer":""}. This encoding replaces plain-text output formatting only.
commentary is optional concise PUBLIC progress/status for the user, never private reasoning, analysis, deliberation, or chain-of-thought.
answer is the substantive user-facing answer, explanation, requested code, or deliverable, with no process preamble or status prose mixed in.
Do not move substantive answers into commentary. Do not put private reasoning in either field. No other keys, markdown fences, or trailing text.
When calling a tool, commentary may describe the public action and answer may contain substantive content already available to the user.
Keep such content in answer even when tools are called; do not relabel it as commentary. With no tool calls, answer must be nonempty.
Use the ordinary native tool_calls channel for tools; never encode tools into these text fields.
Previously unwrapped assistant history is already decoded; only the new response uses this JSON encoding.`

export const PUBLIC_PURPOSE_V2_INSTRUCTIONS = `Public output wire contract (purpose-json-v2):
Encode assistant content as exactly one JSON object IN THIS ORDER:
{"commentary":"","answer":"","outcome":{"status":"satisfied","gaps":[]}}.
commentary is optional concise PUBLIC progress, never private reasoning. answer is the substantive user-facing answer or deliverable; stream it normally before outcome.
With no native tool calls, answer must be nonempty and outcome must be an object with exactly status then gaps.
status is satisfied only when the current requested result was delivered; otherwise use partial or blocked and state the actual missing work publicly in answer and gaps.
A refusal, missing capability, or unperformed requested action is not a satisfied result. Do not invent completed actions or receipts.
This is your declaration, not independent verification. Native authorization, receipts, resources and completion checks remain authoritative.
gaps is an array of at most 16 nonempty strings, each at most 1000 characters and 8192 characters total. satisfied requires []; partial and blocked require at least one gap.
Do not add a separate review or rewrite merely to produce this declaration. No other keys, markdown fences or trailing text. Do not put private reasoning in any field.
When calling native tools, encode any public text with outcome:null; a tool-only message may omit content. Never declare a terminal outcome on a tool-calling turn.
Use the ordinary native tool_calls channel for tools, never encode tools into text. Previously unwrapped history is already decoded; only the new response uses this encoding.`

export function publicPurposeInstructions(protocol: PublicTextProtocol = 'purpose-json-v1'): string {
  return protocol === 'purpose-json-v2' ? PUBLIC_PURPOSE_V2_INSTRUCTIONS : PUBLIC_PURPOSE_INSTRUCTIONS
}

export function publicPurposeError(protocolCode:'public_text_invalid'|'public_text_incomplete'|'public_text_answer_required'='public_text_invalid'):ModelDriverError {
  return new ModelDriverError('invalid public text protocol',{kind:'protocol',category:'protocol',protocolCode,finishReasons:[]})
}
/** Bounded framing state only: released body characters are never buffered until EOF. */
export class PublicPurposeParser {
  private tail=''
  private finished=false
  outcome:OutcomeDeclaration|null|undefined
  constructor(private readonly protocol:PublicTextProtocol='purpose-json-v1') {
    if(protocol==='purpose-json-v2')Object.assign(this.tokens,{10:',',11:'"outcome"',12:':'})
  }
  private stage=0
  private offset=0
  private framing=0
  private size=0
  private escape=''
  private surrogate=''
  private invalid=false
  private readonly tokens:Record<number,string>={0:'{',1:'"commentary"',2:':',3:'"',5:',',6:'"answer"',7:':',8:'"',10:'}'}
  get complete(){return !this.invalid&&(this.protocol==='purpose-json-v2'?this.finished:this.stage===11)}
  push(chunk:string):Array<{text:string;purpose:PublicTextPurpose}> {
    if(this.invalid)throw publicPurposeError()
    this.size+=chunk.length
    if(this.size>256_000){this.invalid=true;throw publicPurposeError()}
    const out:Array<{text:string;purpose:PublicTextPurpose}>=[]
    const append=(value:string)=>{
      const purpose=this.stage===4?'commentary':'answer'
      for(const character of value){
        const code=character.charCodeAt(0)
        let text=character
        if(this.surrogate){
          if(character.length!==1||code<0xdc00||code>0xdfff)throw publicPurposeError()
          text=this.surrogate+character;this.surrogate=''
        }else if(character.length===1&&code>=0xd800&&code<=0xdbff){this.surrogate=character;continue}
        else if(character.length===1&&code>=0xdc00&&code<=0xdfff)throw publicPurposeError()
        const prior=out.at(-1)
        if(prior?.purpose===purpose)prior.text+=text
        else out.push({purpose,text})
      }
    }
    try {
      for(const character of chunk){
        if(this.protocol==='purpose-json-v2'&&this.stage===13){
          this.tail+=character
          if(this.tail.length>32768||this.finished)throw publicPurposeError()
          continue
        }
        if(this.stage===4||this.stage===9){
          if(this.escape){
            this.escape+=character
            if(this.escape==='\\u'||this.escape.startsWith('\\u')&&this.escape.length<6)continue
            append(JSON.parse('"'+this.escape+'"') as string);this.escape=''
          }else if(character==='\\')this.escape=character
          else if(character==='"'){
            if(this.surrogate)throw publicPurposeError()
            this.stage++;this.offset=0
          }else{if(character.charCodeAt(0)<32)throw publicPurposeError();append(character)}
          continue
        }
        if(++this.framing>4096)throw publicPurposeError()
        if(this.offset===0&&/[\t\r\n ]/.test(character))continue
        const token=this.tokens[this.stage]
        if(!token||character!==token[this.offset])throw publicPurposeError()
        if(++this.offset===token.length){this.stage++;this.offset=0}
      }
    }catch{this.invalid=true;throw publicPurposeError()}
    return out
  }
  finish(){
    if(this.protocol==='purpose-json-v2'&&!this.invalid&&this.stage===13){
      try{this.outcome=parseOutcomeTail(this.tail);this.finished=true}catch{this.invalid=true;throw publicPurposeError()}
    }
    if(!this.complete)throw publicPurposeError(this.invalid?'public_text_invalid':'public_text_incomplete')
  }
}
