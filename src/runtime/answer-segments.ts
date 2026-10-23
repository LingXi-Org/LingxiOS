import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { AIMessage, RemoveMessage, type BaseMessage } from '@langchain/core/messages'
import { messagesStateReducer } from '@langchain/langgraph/web'
import { answerMessageId, assemblePublicTextSources, snapshotPublicTextOperation, type PublicTextOperation } from '../protocol/answer-segments.js'
import type { PublicTextIdentity } from '../protocol/public-text.js'
import type { ExecutionStep } from '../control-plane/steps.js'

export interface SealedAnswerSegment { identity:PublicTextIdentity; text:string; bodyHash:string }
const sha=(text:string)=>createHash('sha256').update(text).digest('hex')

/** Trusted adapter over LangGraph's public ID reducer. Sealed revisions remain immutable. */
export class AnswerSegmentSet {
  private active:BaseMessage[]=[]
  private readonly revisions=new Map<string,SealedAnswerSegment>()
  readonly messageId:string
  constructor(readonly runId:string,readonly requestVersion:number,private readonly fence:number,steps:readonly ExecutionStep[]=[]){
    this.messageId=answerMessageId(runId,requestVersion)
    for(const step of steps){
      if(step.kind!=='runtime.answer_segment'||step.requestVersion!==requestVersion||!step.output)continue
      const {text}=JSON.parse(step.output) as {text:unknown}
      if(typeof text!=='string')throw new Error('invalid sealed answer recovery')
      this.seal({identity:step.input as unknown as PublicTextIdentity,text,bodyHash:String(step.input['bodyHash'])})
    }
  }
  get records():readonly SealedAnswerSegment[]{
    return this.active.map(item=>this.revisions.get(String(item.additional_kwargs['partId']))!)
  }
  get hasBody(){return this.records.some(item=>item.text.trim().length>0)}
  get context(){return {messageId:this.messageId,segmentIds:this.records.map(item=>item.identity.partId)}}
  prepare(value:PublicTextOperation,partId:string):string {
    const operation=snapshotPublicTextOperation(value), current=this.records
    if(!partId||this.revisions.has(partId))throw new Error('answer revision identity already exists')
    if(operation.kind==='append')return partId
    const indices=operation.supersedes.map(id=>current.findIndex(item=>item.identity.partId===id))
    if(indices.some((value,index)=>value<0||index>0&&value<=indices[index-1]!))throw new Error('replacement targets must be active revisions in source order')
    return current[indices[0]!]!.identity.segmentId!
  }
  seal(record:SealedAnswerSegment){
    const {identity:source,text,bodyHash}=record
    if(source.purpose!=='answer')throw new Error('invalid sealed answer purpose')
    const identity:PublicTextIdentity={version:source.version,purpose:'answer',messageId:source.messageId!,segmentId:source.segmentId!,partId:source.partId,
      requestVersion:source.requestVersion,fence:source.fence,attemptId:source.attemptId,partIndex:source.partIndex,operation:source.operation!,supersedes:[...source.supersedes??[]]}
    record={identity,text,bodyHash}
    if(identity.version!==3||identity.purpose!=='answer'||identity.messageId!==this.messageId||identity.requestVersion!==this.requestVersion
      ||identity.fence>this.fence||!Number.isSafeInteger(identity.fence)||identity.fence<1||!text||text.length>200_000||sha(text)!==bodyHash)throw new Error('invalid sealed answer source')
    const prior=this.revisions.get(identity.partId)
    if(prior){
      if(!isDeepStrictEqual(prior,record))throw new Error('sealed answer revision is immutable')
      return
    }
    const operation=snapshotPublicTextOperation({kind:identity.operation,supersedes:identity.supersedes})
    const segmentId=this.prepare(operation,identity.partId)
    if(identity.segmentId!==segmentId)throw new Error('answer logical identity changed')
    const update=new AIMessage({id:segmentId,content:text,additional_kwargs:{partId:identity.partId}})
    const removals=operation.supersedes.slice(1).map(partId=>new RemoveMessage({id:this.revisions.get(partId)!.identity.segmentId!}))
    // Only host-created typed messages reach the upstream reducer: no coercion,
    // auto-ID, REMOVE_ALL or unvalidated provider extension fields.
    const next=messagesStateReducer(this.active,[update,...removals])
    if(next.length>128||next.reduce((size,item)=>size+String(item.content).length,0)>200_000)throw new Error('answer source collection exceeds bounds')
    this.revisions.set(identity.partId,structuredClone(record));this.active=next
  }
  assemble(){
    const records=this.records.map(item=>({segmentId:item.identity.segmentId!,partId:item.identity.partId,text:item.text,bodyHash:item.bodyHash}))
    const body=records.map(item=>item.text).join('').trim()
    if(!body)throw new Error('no nonempty sealed answer exists')
    return assemblePublicTextSources(this.messageId,records,sha(body))
  }
}
