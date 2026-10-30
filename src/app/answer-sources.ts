import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { snapshotPublicTextSources, assemblePublicTextSources, answerMessageId } from '../protocol/answer-segments.js'
import { AnswerSegmentSet } from '../runtime/answer-segments.js'
import { fromRow } from '../control-plane/steps.js'
import type { SqlQueryable } from '../control-plane/pg-store.js'
import type { AssistantMessage, WorkItem } from '../protocol/types.js'

/** Runs inside the same locked transaction as result, outcome, event and outbox. */
export async function verifySealedAnswerSources(database:SqlQueryable,work:Omit<WorkItem,'leaseToken'>,message:AssistantMessage){
  const sources=snapshotPublicTextSources(message.publicTextSources,message.body.length)
  if(message.publicTextPartId||sources.messageId!==answerMessageId(work.id,message.envelope.requestVersion)
    ||createHash('sha256').update(message.body).digest('hex')!==sources.bodyHash)throw new Error('invalid assembled answer identity')
  const rows=(await database.query(`SELECT * FROM lingxios.agent_steps WHERE work_id=$1 AND request_version=$2
    AND kind IN ('runtime.answer_segment','runtime.answer_candidate_failure','runtime.candidate','runtime.public_text_source') AND completed_at IS NOT NULL ORDER BY step_seq LIMIT 2049`,
  [work.id,message.envelope.requestVersion])).rows
  if(rows.length>2048)throw new Error('answer source history exceeds recovery bound')
  const steps=rows.map(fromRow), sealed=steps.filter(step=>step.kind==='runtime.answer_segment')
  const selected=sources.segments.map(source=>{
    const step=sealed.find(step=>step.input['partId']===source.partId)
    if(!step||step.input['segmentId']!==source.segmentId||step.input['messageId']!==sources.messageId
      ||step.input['bodyHash']!==source.bodyHash||Number(step.input['fence'])>work.fence)throw new Error('answer source is not sealed in this request')
    const {text}=JSON.parse(step.output!) as {text:string}
    if(typeof text!=='string'||createHash('sha256').update(text).digest('hex')!==source.bodyHash)throw new Error('sealed answer hash mismatch')
    return {...source,text}
  })
  const assembled=assemblePublicTextSources(sources.messageId,selected,sources.bodyHash)
  if(assembled.body!==message.body||!isDeepStrictEqual(assembled.sources,sources))throw new Error('answer source order or ranges changed')
  const candidate=steps.some(step=>['runtime.candidate','runtime.public_text_source'].includes(step.kind)&&isDeepStrictEqual(step.input['publicTextSources'],sources))
  if(!candidate)throw new Error('answer source collection is not bound to a validated candidate')
  const history=new AnswerSegmentSet(work.id,message.envelope.requestVersion,work.fence)
  let wasActive=false
  for(const step of steps){
    if(step.kind==='runtime.answer_candidate_failure'){
      history.fail(step.input as unknown as import('../protocol/public-text.js').PublicTextIdentity)
      continue
    }
    if(step.kind!=='runtime.answer_segment')continue
    const {text}=JSON.parse(step.output!) as {text:string}
    history.seal({identity:step.input as unknown as import('../protocol/public-text.js').PublicTextIdentity,text,bodyHash:String(step.input['bodyHash'])})
    const current=history.records
    if(current.length===sources.segments.length&&current.every((record,index)=>record.identity.partId===sources.segments[index]!.partId)){
      const active=history.assemble()
      if(isDeepStrictEqual(active.sources,sources)&&active.body===message.body)wasActive=true
    }
  }
  if(!wasActive)throw new Error('answer source collection was never an active sealed state')
  if(message.envelope.goalOutcome.status==='satisfied'){
    const latest=history.assemble()
    if(!isDeepStrictEqual(latest.sources,sources)||latest.body!==message.body)throw new Error('successful completion omitted an active answer segment')
  }
}
