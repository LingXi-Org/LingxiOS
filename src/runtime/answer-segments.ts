import {snapshotPublicTextRecovery,type PublicTextRecovery} from '../protocol/public-text-recovery.js'
import type {ModelItem,SessionRecord} from '../protocol/types.js'
import {appendRequestHistory} from '../context/request-history.js'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { answerMessageId, assemblePublicTextSources, snapshotPublicTextOperation, type PublicTextOperation } from '../protocol/answer-segments.js'
import type { PublicTextIdentity } from '../protocol/public-text.js'
import type { ExecutionStep } from '../control-plane/steps.js'
import { decodePublicAnswerCall, publicAnswerHistory } from '../protocol/public-answer-call.js'
import { RUN_SEQUENCE_SPAN } from '../protocol/constants.js'

export interface SealedAnswerSegment { identity:PublicTextIdentity; text:string; bodyHash:string; recovery?:PublicTextRecovery }
interface FailedAnswerCandidate { identity:PublicTextIdentity; targets:string[]; active:string[]; retired:boolean }
const sha=(text:string)=>createHash('sha256').update(text).digest('hex')

/** Active revisions retain source order; sealed history remains immutable. */
export class AnswerSegmentSet {
  private active:string[]=[]
  private readonly revisions=new Map<string,SealedAnswerSegment>()
  private readonly failures=new Map<string,FailedAnswerCandidate>()
  readonly messageId:string
  constructor(readonly runId:string,readonly requestVersion:number,private readonly fence:number,steps:readonly ExecutionStep[]=[]){
    this.messageId=answerMessageId(runId,requestVersion)
    for(const step of steps){
      if(step.kind==='runtime.answer_candidate_failure'&&step.requestVersion===requestVersion){
        const endedSeq=step.input['endedSeq'],source=step.input as unknown as PublicTextIdentity
        if(!Number.isSafeInteger(endedSeq)||Number(endedSeq)<1||Math.floor((Number(endedSeq)-1)/RUN_SEQUENCE_SPAN)+1!==source.fence)throw new Error('invalid failed answer recovery')
        this.fail(source)
        continue
      }
      if(step.kind!=='runtime.answer_segment'||step.requestVersion!==requestVersion||!step.output)continue
      const {text,recovery}=JSON.parse(step.output) as {text:unknown;recovery?:PublicTextRecovery}
      if(typeof text!=='string')throw new Error('invalid sealed answer recovery')
      this.seal({identity:step.input as unknown as PublicTextIdentity,text,bodyHash:String(step.input['bodyHash']),...(recovery?{recovery:snapshotPublicTextRecovery(recovery)}:{})})
    }
  }
  /** Seal is durable before session save. Restore only acknowledged typed messages,
   * with original memory dependencies; the ordinary live projection filters them.
   * The session cursor survives compaction, so archived messages are not reinserted. */
  restoreMessageHistory(session:SessionRecord,workId:string):boolean {
    if(!session.request || session.request.workId!==workId || session.request.revisions.length+1!==this.requestVersion)throw new Error('sealed history request identity mismatch')
    const previous=session.request.publicTextHistory
    const partIds=previous?.requestVersion===this.requestVersion?[...previous.partIds]:[]
    if(partIds.length>128 || new Set(partIds).size!==partIds.length || partIds.some(id=>!this.revisions.get(id)?.recovery))throw new Error('invalid sealed history cursor')
    let changed=false
    for(const record of this.revisions.values()){
      if(!record.recovery||partIds.includes(record.identity.partId))continue
      const items:ModelItem[]=record.recovery.version===2
        ? publicAnswerHistory(record.recovery.publicAnswerCall,record.recovery.memorySources)
        : [{role:'assistant',content:record.text,memorySources:record.recovery.memorySources}]
      appendRequestHistory(session,workId,...items)
      partIds.push(record.identity.partId);changed=true
    }
    if(changed)session.request.publicTextHistory={requestVersion:this.requestVersion,partIds}
    return changed
  }
  get records():readonly SealedAnswerSegment[]{
    return this.active.map(partId=>this.revisions.get(partId)!)
  }
  get hasBody(){return this.records.some(item=>item.text.trim().length>0)}
  /** Sealed revisions outlive compaction of their model-history representation. */
  hasPublicAnswerCall(callId:string):boolean {
    return [...this.revisions.values()].some(record=>record.recovery?.version===2&&record.recovery.publicAnswerCall.callId===callId)
  }
  get context(){return {messageId:this.messageId,segmentIds:this.records.map(item=>item.identity.partId)}}
  /** Failed candidates supply correction identities, never body/history sources. */
  get correctionSources():readonly string[]{
    const pending=[...this.failures.values()].findLast(candidate=>!candidate.retired&&isDeepStrictEqual(candidate.active,this.active))
    return pending?[pending.identity.partId]:this.context.segmentIds
  }
  private identity(source:PublicTextIdentity):PublicTextIdentity {
    const validId=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=1000
    if(source.version!==3||source.purpose!=='answer'||source.messageId!==this.messageId||source.requestVersion!==this.requestVersion
      ||!Number.isSafeInteger(source.fence)||source.fence<1||source.fence>this.fence||!Number.isSafeInteger(source.partIndex)||source.partIndex<0
      ||![source.partId,source.segmentId,source.attemptId].every(validId))throw new Error('invalid answer source identity')
    const operation=snapshotPublicTextOperation({kind:source.operation,supersedes:source.supersedes})
    return {version:3,purpose:'answer',messageId:this.messageId,segmentId:source.segmentId!,partId:source.partId,
      requestVersion:this.requestVersion,fence:source.fence,attemptId:source.attemptId,partIndex:source.partIndex,
      operation:operation.kind,supersedes:operation.supersedes}
  }
  /** Register only an acknowledged failed end. No text, hash, seal or model history is accepted. */
  fail(source:PublicTextIdentity):void {
    const identity=this.identity(source),prior=this.failures.get(identity.partId)
    if(prior){if(!isDeepStrictEqual(prior.identity,identity))throw new Error('failed answer identity is immutable');return}
    if(this.failures.size>=128)throw new Error('failed answer collection exceeds bounds')
    const plan=this.plan({kind:identity.operation!,supersedes:identity.supersedes!},identity.partId)
    if(identity.segmentId!==plan.segmentId)throw new Error('failed answer logical identity changed')
    if(plan.targets.some(id=>this.revisions.get(id)!.identity.fence>identity.fence)
      ||plan.failed&&this.failures.get(plan.failed)!.identity.fence>identity.fence)throw new Error('failed answer lineage is from a newer fence')
    this.failures.set(identity.partId,{identity,targets:plan.targets,active:[...this.active],retired:false})
    if(plan.failed)this.failures.get(plan.failed)!.retired=true
  }
  private plan(value:PublicTextOperation,partId:string):{segmentId:string;targets:string[];failed?:string}{
    const operation=snapshotPublicTextOperation(value),current=this.records
    if(!partId||partId.length>1000||this.revisions.has(partId)||this.failures.has(partId))throw new Error('answer revision identity already exists')
    if(operation.kind==='append')return {segmentId:partId,targets:[]}
    const failed=operation.supersedes.length===1?this.failures.get(operation.supersedes[0]!):undefined
    if(failed){
      if(failed.retired||!isDeepStrictEqual(failed.active,this.active))throw new Error('failed replacement target is no longer current')
      return {segmentId:failed.identity.segmentId!,targets:[...failed.targets],failed:failed.identity.partId}
    }
    const indices=operation.supersedes.map(id=>current.findIndex(item=>item.identity.partId===id))
    if(indices.some((value,index)=>value<0||index>0&&value<=indices[index-1]!))throw new Error('replacement targets must be active revisions in source order')
    return {segmentId:current[indices[0]!]!.identity.segmentId!,targets:[...operation.supersedes]}
  }
  prepare(value:PublicTextOperation,partId:string):string {
    return this.plan(value,partId).segmentId
  }
  seal(record:SealedAnswerSegment){
    const {identity:source,text,bodyHash}=record
    const identity=this.identity(source)
    record={identity,text,bodyHash,...(record.recovery?{recovery:snapshotPublicTextRecovery(record.recovery)}:{})}
    if(identity.version!==3||identity.purpose!=='answer'||identity.messageId!==this.messageId||identity.requestVersion!==this.requestVersion
      ||identity.fence>this.fence||!Number.isSafeInteger(identity.fence)||identity.fence<1||!text||text.length>200_000||sha(text)!==bodyHash)throw new Error('invalid sealed answer source')
    const prior=this.revisions.get(identity.partId)
    if(prior){
      if(!isDeepStrictEqual(prior,record))throw new Error('sealed answer revision is immutable')
      return
    }
    const operation=snapshotPublicTextOperation({kind:identity.operation,supersedes:identity.supersedes})
    if(record.recovery?.version===2){
      const call=record.recovery.publicAnswerCall,decoded=decodePublicAnswerCall(call)
      if(decoded.text!==text||!isDeepStrictEqual(decoded.operation,operation))throw new Error('sealed output call does not match source')
      if(this.hasPublicAnswerCall(call.callId))throw new Error('sealed output call identity reused')
    }
    const plan=this.plan(operation,identity.partId)
    if(identity.segmentId!==plan.segmentId)throw new Error('answer logical identity changed')
    if(plan.targets.some(id=>this.revisions.get(id)!.identity.fence>identity.fence)
      ||plan.failed&&this.failures.get(plan.failed)!.identity.fence>identity.fence)throw new Error('answer lineage is from a newer fence')
    const next=!plan.targets.length ? [...this.active,identity.partId]
      : this.active.filter(partId=>!plan.targets.slice(1).includes(partId))
        .map(partId=>partId===plan.targets[0]?identity.partId:partId)
    if(next.length>128||next.reduce((size,partId)=>size+(partId===identity.partId?text:this.revisions.get(partId)!.text).length,0)>200_000)throw new Error('answer source collection exceeds bounds')
    this.revisions.set(identity.partId,structuredClone(record));this.active=next
    if(plan.failed)this.failures.get(plan.failed)!.retired=true
  }
  assemble(){
    const records=this.records.map(item=>({segmentId:item.identity.segmentId!,partId:item.identity.partId,text:item.text,bodyHash:item.bodyHash}))
    const body=records.map(item=>item.text).join('').trim()
    if(!body)throw new Error('no nonempty sealed answer exists')
    return assemblePublicTextSources(this.messageId,records,sha(body))
  }
}
