import type { PublicTextProtocol } from '../model/outcome-declaration.js'
import type { PublicTextEndReason, PublicTextIdentity, PublicTextSafetyInput, PublicTextSafetyDecision } from '../protocol/public-text.js'
import type { RunEvent } from '../protocol/types.js'
import { LeaseLostError, ModelDriverError, RunCancelledError } from '../errors.js'
import { createHash } from 'node:crypto'
import { snapshotPublicTextOperation, type PublicTextOperation } from '../protocol/answer-segments.js'

/** Persistence failure never retries the provider or exposes an uncommitted buffer. */
export class PublicTextPublicationError extends ModelDriverError {
  constructor(readonly stage: PublicationFailure['stage']='unknown', readonly rejection: PublicationFailure['code']='unknown', cause?: unknown){
    super('public text could not be persisted',{kind:'provider',category:'unknown',finishReasons:[]},cause===undefined?undefined:{cause})
  }
}
export interface PublicationFailure {
  stage: 'unknown'|'push'|'operation'|'delta'|'seal'
  code: 'unknown'|'closed'|'content_type'|'operation_state'|'missing_operation'|'source_state'|'persistence_rejected'
}
/** Closed codes only. Original causes stay in memory for the existing safe
 * SQL/system classification, never in public events or persisted diagnostics. */
export function readPublicationFailure(value: unknown): PublicationFailure | undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined
  const stage=Reflect.get(value,'stage'),code=Reflect.get(value,'code')
  if(Object.keys(value).some(key=>!['stage','code'].includes(key))
    ||!['unknown','push','operation','delta','seal'].includes(stage)
    ||!['unknown','closed','content_type','operation_state','missing_operation','source_state','persistence_rejected'].includes(code))return undefined
  return {stage,code}
}
/** Only a closed code crosses the boundary; never retain a policy exception or rejected text. */
export class PublicTextSafetyError extends ModelDriverError {
  constructor(readonly rejection:'unsafe_content'|'unsupported_content'|'invalid_decision'|'policy_error'){
    super('public text was not approved',{kind:'protocol',category:'protocol',finishReasons:[]})
  }
}
export function isPublicTextSafetyFailure(error:unknown):boolean {
  for(let current=error,depth=0;current instanceof Error&&depth<8;depth++,current=current.cause){
    if(current instanceof PublicTextSafetyError)return true
  }
  return false
}
/** Drivers may wrap callback errors to preserve already-received token usage. */
export function isPublicTextPublicationFailure(error:unknown):boolean {
  for(let current=error,depth=0;current instanceof Error&&depth<8;depth++,current=current.cause){
    if(current instanceof PublicTextPublicationError||current instanceof PublicTextSafetyError)return true
  }
  return false
}
const MAX_RECEIVED_BYTES=200_000,MAX_HELD_BYTES=65_536
const highSurrogate=(code:number)=>code>=0xD800&&code<=0xDBFF
const lowSurrogate=(code:number)=>code>=0xDC00&&code<=0xDFFF

/** One provider attempt owns the safety approval and bounded append-only buffer. */
export class PublicTextWriter {
  private text=''
  private received=''
  private receivedBytes=0
  private approvedThrough=0
  private approvedBytes=0
  private assessedBytes=0
  private assessedLength=0
  private assessments=0
  private chunks=0
  private closed=false
  private suspended=false
  private finished=false
  private failure:unknown
  private tail:Promise<void>=Promise.resolve()
  private timer:ReturnType<typeof setTimeout>|undefined
  private heldTimer:ReturnType<typeof setTimeout>|undefined
  constructor(private readonly identity:PublicTextIdentity,
    private readonly emit:(event:Omit<RunEvent,'runId'|'seq'>)=>Promise<unknown>,private readonly signal:AbortSignal,
    private readonly assess?:((input:Readonly<PublicTextSafetyInput>)=>PublicTextSafetyDecision)|undefined){}

  /** Only successfully appended deltas can be associated with a final candidate. */
  get partId():string|undefined{return this.chunks?this.identity.partId:undefined}
  get chunkCount(){return this.chunks}

  private approval(text:string,isFinal:boolean):number {
    let decision:PublicTextSafetyDecision
    try{decision=this.assess ? this.assess(Object.freeze({text,isFinal,approvedThrough:this.approvedThrough})) : {safeThrough:text.length}}
    catch{throw new PublicTextSafetyError('policy_error')}
    if(decision&&typeof (decision as unknown as {then?:unknown}).then==='function'){
      void Promise.resolve(decision).catch(()=>{})
      throw new PublicTextSafetyError('invalid_decision')
    }
    if(!decision||!Number.isSafeInteger(decision.safeThrough)||decision.safeThrough<this.approvedThrough||decision.safeThrough>text.length
      ||decision.reject!==undefined&&!['unsafe_content','unsupported_content'].includes(decision.reject))throw new PublicTextSafetyError('invalid_decision')
    if(decision.reject)throw new PublicTextSafetyError(decision.reject)
    let through=decision.safeThrough
    if(through>0&&highSurrogate(text.charCodeAt(through-1))){
      if(through<text.length&&lowSurrogate(text.charCodeAt(through)))throw new PublicTextSafetyError('invalid_decision')
      if(through===text.length)through-- // A provider may split one code point across deltas.
    }
    if(isFinal&&through!==text.length)throw new PublicTextSafetyError('unsupported_content')
    return through
  }
  async push(delta:string):Promise<void>{
    this.signal.throwIfAborted()
    if(this.failure)throw this.failure
    await this.tail
    if(this.suspended)return
    if(this.closed||this.finished)throw new PublicTextPublicationError('push','closed')
    if(typeof delta!=='string')throw new PublicTextPublicationError('push','content_type')
    this.receivedBytes+=Buffer.byteLength(delta)
    if(this.receivedBytes>MAX_RECEIVED_BYTES){await this.suspend();return}
    this.received+=delta
    // Run the cumulative policy once at the first delta and then at bounded
    // coalescing boundaries, not once per provider token.
    if(!this.assessments||this.receivedBytes-this.assessedBytes>=4096)await this.assessBuffer()
    else if(!this.timer)this.timer=setTimeout(()=>{
      this.timer=undefined
      void this.assessBuffer().catch(error=>{
        this.failure=error
        if(isPublicTextSafetyFailure(error))void this.end('failed').catch(()=>{})
      })
    },50)
    await this.tail
  }
  private async assessBuffer():Promise<void>{
    if(this.timer){clearTimeout(this.timer);this.timer=undefined}
    if(this.suspended||this.closed)return
    const previousApproved=this.approvedThrough, previousLength=this.assessedLength
    const through=this.approval(this.received,false)
    this.assessments++;this.assessedBytes=this.receivedBytes;this.assessedLength=this.received.length
    const approved=this.received.slice(previousApproved,through)
    this.approvedThrough=through;this.approvedBytes+=Buffer.byteLength(approved)
    if(approved)await this.publish(approved)
    if(this.suspended||this.closed)return
    const held=through<this.received.length
    if(this.receivedBytes-this.approvedBytes>MAX_HELD_BYTES){await this.suspend();return}
    if(!held||through>=previousLength)this.clearHeldTimer()
    if(held&&!this.heldTimer)this.heldTimer=setTimeout(()=>{
      this.heldTimer=undefined
      // An uncertain suffix pauses commentary, never the provider or final-answer path.
      void this.suspend().catch(error=>{this.failure=error})
    },1000)
  }
  private async publish(text:string):Promise<void>{
    this.text+=text
    await this.flush()
  }
  /** Validate EOF using the existing model result after suspension; never accumulate another copy. */
  async finish(finalText=this.received):Promise<void>{
    this.signal.throwIfAborted()
    if(this.failure)throw this.failure
    if(this.finished)return
    this.clearHeldTimer()
    if(this.timer){clearTimeout(this.timer);this.timer=undefined}
    const through=this.approval(finalText,true)
    if(!this.suspended){
      if(!finalText.startsWith(this.received))throw new PublicTextSafetyError('invalid_decision')
      // EOF safety checks the whole result, but publication only archives
      // bytes actually received through onTextDelta. A non-streaming driver
      // return is the separate final-answer channel, not another commentary part.
      let observedThrough=Math.min(through,this.received.length)
      if(observedThrough>0&&highSurrogate(finalText.charCodeAt(observedThrough-1))
        &&lowSurrogate(finalText.charCodeAt(observedThrough)))observedThrough--
      const approved=this.received.slice(this.approvedThrough,observedThrough)
      this.approvedThrough=observedThrough
      if(approved)await this.publish(approved)
      await this.flush()
    }
    this.received='';this.finished=true
  }
  private clearHeldTimer(){if(this.heldTimer)clearTimeout(this.heldTimer);this.heldTimer=undefined}
  private async suspend():Promise<void>{
    if(this.suspended||this.closed)return
    this.suspended=true;this.received='';this.text='';this.clearHeldTimer()
    if(this.timer)clearTimeout(this.timer);this.timer=undefined
    await this.close('interrupted')
  }
  private flush():Promise<void>{
    if(this.timer){clearTimeout(this.timer);this.timer=undefined}
    const pending=this.text;this.text=''
    if(!pending)return this.tail
    const task=this.tail.then(async()=>{
      if(this.failure)throw this.failure
      let chunk='',bytes=0
      const append=async()=>{
        if(!chunk)return
        this.signal.throwIfAborted()
        await this.emit({kind:'public.text.delta',stage:'delta',visibility:'user',data:{...this.identity,chunkIndex:this.chunks,text:chunk}})
        this.chunks++;chunk='';bytes=0
      }
      for(const point of pending){const size=Buffer.byteLength(point);if(bytes+size>4096)await append();chunk+=point;bytes+=size}
      await append()
    }).catch(error=>{this.failure=new PublicTextPublicationError('delta','persistence_rejected',error);throw this.failure})
    this.tail=task
    void task.catch(()=>{})
    return task
  }
  private async close(reason:PublicTextEndReason):Promise<void>{
    if(this.closed)return
    this.closed=true
    await this.tail
    if(this.chunks&&!this.signal.aborted)await this.emit({kind:'public.text.ended',stage:'completed',visibility:'user',data:{...this.identity,chunkCount:this.chunks,reason}})
  }
  async end(reason:PublicTextEndReason):Promise<void>{
    this.clearHeldTimer()
    if(this.timer){clearTimeout(this.timer);this.timer=undefined}
    if(this.signal.aborted){this.text='';this.received='';await this.tail.catch(()=>{});this.closed=true;return}
    if(this.closed)return
    if(reason==='completed'||reason==='tool')await this.finish()
    else{this.text='';this.received=''}
    await this.close(reason)
  }
  dispose(){this.closed=true;this.text='';this.received='';this.clearHeldTimer();if(this.timer)clearTimeout(this.timer);this.timer=undefined}
}

/** One attempt, separately identified public purposes. Legacy drivers keep one unknown-purpose part. */
export class PublicTextAttemptWriter {
  private readonly writers=new Map<'legacy'|'commentary'|'answer',PublicTextWriter>()
  private answerStarted=false
  private operation:PublicTextOperation|undefined
  private sealed=false
  constructor(private readonly identity:PublicTextIdentity,
    private readonly emit:(event:Omit<RunEvent,'runId'|'seq'>)=>Promise<unknown>,private readonly signal:AbortSignal,
    private readonly assess:((input:Readonly<PublicTextSafetyInput>)=>PublicTextSafetyDecision)|undefined,
    private readonly protocol:PublicTextProtocol|undefined){}
  get partId(){return this.writers.get(this.protocol?'answer':'legacy')?.partId}
  get answerRevisionId(){return this.identity.partId+':answer'}
  get segmentIdentity():PublicTextIdentity|undefined {
    if(this.protocol!=='purpose-json-v3'||!this.operation)return undefined
    const partId=this.identity.partId+':answer',segmentId=this.identity.segmentId??partId
    return {...this.identity,version:3,purpose:'answer',partIndex:1,partId,segmentId,
      operation:this.operation.kind,supersedes:[...this.operation.supersedes]}
  }
  async begin(operation:PublicTextOperation,segmentId?:string){
    if(this.protocol!=='purpose-json-v3'||this.operation)throw new PublicTextPublicationError('operation','operation_state')
    this.operation=snapshotPublicTextOperation(operation)
    if(segmentId)this.identity.segmentId=segmentId
    this.signal.throwIfAborted()
    await this.emit({kind:'public.text.operation',stage:'started',visibility:'user',data:{...this.segmentIdentity!}})
  }
  async push(text:string,metadata?:{purpose:import('../protocol/public-text.js').PublicTextPurpose}){
    const key=this.protocol?metadata?.purpose:'legacy'
    if(!key||!['legacy','commentary','answer'].includes(key)||!this.protocol&&metadata
      // Native v3 JSON object members are unordered. Its parser validates field
      // identity/types; commentary may first arrive after streamed answer text.
      ||key==='commentary'&&this.answerStarted&&this.protocol!=='purpose-json-v3')throw new ModelDriverError('invalid public text protocol',{kind:'protocol',category:'protocol',protocolCode:'public_text_invalid',finishReasons:[]})
    if(this.protocol==='purpose-json-v3'&&key==='answer'&&!this.operation)throw new PublicTextPublicationError('push','missing_operation')
    if(key==='answer'&&!this.answerStarted){
      this.answerStarted=true
      await this.writers.get('commentary')?.end('completed')
    }
    let writer=this.writers.get(key)
    if(!writer){
      const {messageId:_message,segmentId:_segment,operation:_operation,supersedes:_supersedes,...legacy}=this.identity
      writer=new PublicTextWriter(key==='legacy'?this.identity:key==='answer'&&this.protocol==='purpose-json-v3'?this.segmentIdentity!:
        {...legacy,version:2,purpose:key,partIndex:key==='answer'?1:0,partId:this.identity.partId+':'+key},this.emit,this.signal,this.assess)
      this.writers.set(key,writer)
    }
    await writer.push(text)
  }
  async finish(text:string){
    await this.writers.get('commentary')?.finish()
    await this.writers.get(this.protocol?'answer':'legacy')?.finish(text)
  }
  async end(reason:PublicTextEndReason){for(const writer of this.writers.values())await writer.end(reason)}
  async seal(text:string,publicTextRecovery?:import('../protocol/public-text-recovery.js').PublicTextRecovery){
    const writer=this.writers.get('answer'),identity=this.segmentIdentity
    if(!identity||!writer?.partId||this.sealed)throw new PublicTextPublicationError('seal','source_state')
    this.signal.throwIfAborted()
    const bodyHash=createHash('sha256').update(text).digest('hex')
    try {
      await this.emit({kind:'public.text.sealed',stage:'completed',visibility:'user',data:{...identity,chunkCount:writer.chunkCount,bodyHash},...(publicTextRecovery?{publicTextRecovery}:{})})
    } catch(error) {
      if(error instanceof LeaseLostError||error instanceof RunCancelledError||this.signal.aborted)throw error
      // A storage/authorization rejection is not a model-format correction.
      // Never continue into a business tool after failing to persist its output.
      throw new PublicTextPublicationError('seal','persistence_rejected',error)
    }
    this.sealed=true
    return {identity,text,bodyHash,...(publicTextRecovery?{recovery:publicTextRecovery}:{})}
  }
  dispose(){for(const writer of this.writers.values())writer.dispose()}
}
