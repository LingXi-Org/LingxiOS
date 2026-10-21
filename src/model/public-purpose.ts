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

export function publicPurposeError():ModelDriverError {
  return new ModelDriverError('invalid public text protocol',{kind:'protocol',category:'protocol',finishReasons:[]})
}
/** Bounded framing state only: released body characters are never buffered until EOF. */
export class PublicPurposeParser {
  private stage=0
  private offset=0
  private framing=0
  private size=0
  private escape=''
  private surrogate=''
  private invalid=false
  private readonly tokens:Record<number,string>={0:'{',1:'"commentary"',2:':',3:'"',5:',',6:'"answer"',7:':',8:'"',10:'}'}
  get complete(){return !this.invalid&&this.stage===11}
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
  finish(){if(!this.complete)throw publicPurposeError()}
}
