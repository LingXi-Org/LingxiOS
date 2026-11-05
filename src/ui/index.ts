import type { PublicTextAttempt } from '../app/public-text.js'
export type { PublicTextAttempt } from '../app/public-text.js'
import { publicTextPayload, publicTextStatus, type PublicTextPart, type PublicTextEndReason } from '../protocol/public-text.js'
export type { PublicTextPart, PublicTextEndReason, PublicTextIdentity, PublicTextDelta, PublicTextEnded, PublicTextOperationEvent, PublicTextSealed } from '../protocol/public-text.js'
import { answerMessageId, assemblePublicTextSources, snapshotPublicTextSources, type PublicTextSources } from '../protocol/answer-segments.js'
export { snapshotPublicTextSources, snapshotPublicTextOperation } from '../protocol/answer-segments.js'
export type { PublicTextSources, PublicTextSource, PublicTextOperation } from '../protocol/answer-segments.js'
import type { AssistantMessage, RunEvent } from '../protocol/types.js'
export { releaseVersions } from '../versions.js'
export type { ConversationIdentity, ThreadIdentity, Audience, Visibility, IMDeliveryContext, IMDeliveryReceipt } from '../collaboration/types.js'
import { isGoalOutcome, type GoalOutcome } from '../protocol/outcome.js'
import type { CitationAnnotation, ResponseEnvelope } from '../outcome/envelope.js'
import { citationSources, snapshotCitationEvidence } from '../context/evidence.js'
import { RUN_SEQUENCE_SPAN } from '../protocol/constants.js'
import type { RunState, DeliveryState } from '../app/jobs.js'
import type { RunStreamEvent, PreviewUpdate } from '../app/realtime.js'
export type { RunStreamEvent, PreviewUpdate } from '../app/realtime.js'
export type { RunState, RunSnapshot, DeliveryState } from '../app/jobs.js'
export type { AssistantMessage, RunEvent } from '../protocol/types.js'
export type { ResponseEnvelope, CitationAnnotation } from '../outcome/envelope.js'
export type { CitationEvidence } from '../context/evidence.js'
export type { TrustedPresentation } from '../presentation/definition.js'

export interface RunView {
  /** Durable published commentary; older snapshots may omit this additive field. */
  publicTextParts?: readonly PublicTextPart[]
  publicTextAttempts?: readonly PublicTextAttempt[]
  /** Only populated by the native committed-result channel, never model events. */
  publicTextCommit?: { sources: PublicTextSources; resultId: string; requestVersion: number; fence: number }
  preview?: { attemptId: string; seq: number; fence: number; requestVersion: number } | null
  previewClosedFence?: number
  runId: string
  lastSeq: number
  draft: string
  message: AssistantMessage | null
  goalOutcome: GoalOutcome | null
  requestVersion: number
  fence: number
  messageFence: number
  resultId: string | null
  lifecycle: RunState['run']['status'] | null
  delivery: DeliveryState | null
}

export function createRunView(runId: string): RunView {
  return { runId, publicTextParts: [], lastSeq: 0, draft: '', message: null, goalOutcome: null, requestVersion: 0, fence: 0,
    messageFence: 0, resultId: null, lifecycle: null, delivery: null }
}

function settlePublicText(view: RunView): RunView {
  const parts = view.publicTextParts ?? []
  return { ...view, publicTextParts: parts.map(part => {
    if (part.endedSeq != null) return part
    const attempt = view.publicTextAttempts?.find(attempt => attempt.fence === part.fence)
    const reason: PublicTextEndReason | null = part.fence === view.fence && part.requestVersion < view.requestVersion
      ? 'superseded' : attempt?.reason ?? (part.fence < view.fence || part.requestVersion < view.requestVersion ? 'superseded'
        : part.fence === view.fence && part.requestVersion === view.requestVersion
          ? view.lifecycle === 'cancelled' ? 'cancelled' : view.lifecycle === 'failed' ? 'failed'
            : view.lifecycle && !['leased','queued'].includes(view.lifecycle) ? 'interrupted' : null : null)
    return reason ? { ...part, reason, status: publicTextStatus(reason) } : part
  }) }
}
/** Merge bounded attempt metadata accompanying an authorized event page. */
export function consumePublicTextAttempts(view: RunView, attempts: readonly PublicTextAttempt[]): RunView {
  const known = new Map((view.publicTextAttempts ?? []).map(attempt=>[attempt.fence,attempt]))
  for (const attempt of attempts) {
    if (!Number.isSafeInteger(attempt.fence) || attempt.fence<1 || !['failed','cancelled','interrupted','superseded'].includes(attempt.reason)) throw new Error('invalid public text attempt state')
    known.set(attempt.fence,{...attempt})
  }
  return settlePublicText({...view,publicTextAttempts:[...known.values()].sort((a,b)=>a.fence-b.fence)})
}
function associatePublicText(view:RunView,partId:unknown,resultId:unknown,requestVersion:unknown,fence:number):RunView {
  if(typeof partId!=='string'||!partId||typeof resultId!=='string'||!resultId||!Number.isSafeInteger(requestVersion))return view
  return {...view,publicTextParts:(view.publicTextParts??[]).map(part=>part.version!==3&&part.purpose!=='commentary'&&part.partId===partId&&part.requestVersion===requestVersion&&part.fence<=fence
    ? {...part,acceptedResultId:resultId}:part)}
}
function validateAnswerSources(view:RunView,value:unknown,requestVersion:number,fence:number,body?:string):PublicTextSources {
  const sources=snapshotPublicTextSources(value,body?.length)
  if(!Number.isSafeInteger(requestVersion)||requestVersion<1||!Number.isSafeInteger(fence)||fence<1
    ||sources.messageId!==answerMessageId(view.runId,requestVersion))throw new Error('committed answer source identity changed')
  const parts=sources.segments.map(source=>{
    const part=view.publicTextParts?.find(part=>part.partId===source.partId)
    if(part&&(part.version!==3||part.messageId!==sources.messageId||part.requestVersion!==requestVersion||part.fence>fence
      ||part.segmentId!==source.segmentId||part.bodyHash!==undefined&&part.bodyHash!==source.bodyHash))throw new Error('committed answer source differs from its archive')
    return part
  })
  if(parts.every((part):part is PublicTextPart=>Boolean(part?.sealedSeq&&part.bodyHash))){
    const assembled=assemblePublicTextSources(sources.messageId,parts.map(part=>({segmentId:part.segmentId!,partId:part.partId,bodyHash:part.bodyHash!,text:part.text})),sources.bodyHash)
    if(JSON.stringify(snapshotPublicTextSources(assembled.sources))!==JSON.stringify(sources)||body!==undefined&&assembled.body!==body)throw new Error('committed answer source ranges or text changed')
  }
  return sources
}
function associateAnswerSources(view:RunView):RunView {
  const commit=view.publicTextCommit
  if(!commit)return view
  const body=view.resultId===commit.resultId&&view.message?.envelope.requestVersion===commit.requestVersion?view.message.body:undefined
  validateAnswerSources(view,commit.sources,commit.requestVersion,commit.fence,body)
  return {...view,publicTextParts:(view.publicTextParts??[]).map(part=>part.version===3&&part.sealedSeq&&part.requestVersion===commit.requestVersion
    &&commit.sources.segments.some(source=>source.partId===part.partId&&source.segmentId===part.segmentId&&source.bodyHash===part.bodyHash)
    ? {...part,acceptedResultId:commit.resultId}:part)}
}
function commitAnswerSources(view:RunView,value:unknown,resultId:unknown,requestVersion:unknown,fence:number,body?:string):RunView {
  if(typeof resultId!=='string'||!resultId||typeof requestVersion!=='number')throw new Error('committed answer result identity required')
  const sources=validateAnswerSources(view,value,requestVersion,fence,body),prior=view.publicTextCommit
  if(prior&&prior.resultId===resultId&&(prior.fence!==fence||prior.requestVersion!==requestVersion||JSON.stringify(prior.sources)!==JSON.stringify(sources)))throw new Error('committed answer sources are immutable')
  if(prior&&fence===prior.fence&&requestVersion===prior.requestVersion&&resultId!==prior.resultId)throw new Error('committed answer result identity changed')
  if(prior&&(requestVersion<prior.requestVersion||fence<prior.fence||fence===prior.fence&&resultId!==prior.resultId))return view
  return associateAnswerSources({...view,publicTextCommit:{sources,resultId,requestVersion,fence}})
}
function archivePublicText(view: RunView, event: RunEvent): RunView {
  const data = publicTextPayload(event)
  if (!data) return view
  const parts = [...view.publicTextParts ?? []], index = parts.findIndex(part => part.partId === data.partId)
  const prior = parts[index]
  if (prior && ['version','purpose','requestVersion','fence','attemptId','partIndex'].some(key => Reflect.get(prior,key)!==Reflect.get(data,key))) throw new Error('public text identity changed')
  if(prior&&data.version===3&&(['messageId','segmentId','operation'].some(key=>Reflect.get(prior,key)!==Reflect.get(data,key))
    ||JSON.stringify(prior.supersedes)!==JSON.stringify(data.supersedes)))throw new Error('answer segment operation changed')
  if(event.kind==='public.text.operation'){
    if(prior)throw new Error('answer segment operation already exists')
    parts.push({...data,supersedes:[...data.supersedes??[]],runId:event.runId,text:'',firstSeq:event.seq,lastSeq:event.seq,chunkCount:0,endedSeq:null,acceptedResultId:null,status:'running',reason:null})
  }else if ('text' in data) {
    if(data.version===3&&(!prior||prior.endedSeq!==null||prior.sealedSeq!==undefined))throw new Error('answer delta requires its open operation')
    if (data.chunkIndex !== (prior?.chunkCount ?? 0)) throw new Error('public text chunk sequence is incomplete')
    const part: PublicTextPart = prior ? { ...prior,text:prior.text+data.text,lastSeq:event.seq,chunkCount:prior.chunkCount+1 }
      : { version:data.version,...(data.purpose?{purpose:data.purpose}:{}),runId:event.runId,requestVersion:data.requestVersion,fence:data.fence,attemptId:data.attemptId,
        partId:data.partId,partIndex:data.partIndex,text:data.text,firstSeq:event.seq,lastSeq:event.seq,chunkCount:1,endedSeq:null,acceptedResultId:null,status:'running',reason:null }
    if(data.version===3&&part.text.length>200_000)throw new Error('answer segment exceeds bounds')
    if (prior) parts[index]=part; else parts.push(part)
  } else if('bodyHash' in data){
    if(!prior||prior.endedSeq===null||!['completed','tool'].includes(prior.reason??'')||prior.chunkCount!==data.chunkCount||prior.sealedSeq!==undefined)throw new Error('answer seal requires its complete ended source')
    parts[index]={...prior,lastSeq:event.seq,bodyHash:data.bodyHash,sealedSeq:event.seq}
  } else if('reason' in data){
    if (!prior || prior.chunkCount !== data.chunkCount) throw new Error('public text end is missing its committed chunks')
    if(data.version===3&&prior.endedSeq!==null)throw new Error('answer segment already ended')
    parts[index]={ ...prior,lastSeq:event.seq,endedSeq:event.seq,reason:data.reason,status:publicTextStatus(data.reason) }
  } else {
    throw new Error('invalid public text operation')
  }
  const next = { ...view,publicTextParts:parts.sort((a,b)=>a.firstSeq-b.firstSeq) }
  return settlePublicText(associateAnswerSources(view.message ? associatePublicText(next,view.message.publicTextPartId,view.resultId,view.message.envelope.requestVersion,view.messageFence) : next))
}

/** Consume ordered, replayable public events. Draft text is never a committed message. */
export function consumeRunEvent(view: RunView, event: RunEvent): RunView {
  if (event.runId !== view.runId || event.visibility !== 'user' || !Number.isSafeInteger(event.seq) || event.seq <= view.lastSeq) return view
  let next = { ...view, lastSeq: event.seq }
  if (['public.text.delta','public.text.ended','public.text.operation','public.text.sealed'].includes(event.kind)) return archivePublicText(next,event)
  const fence = Math.floor((event.seq - 1) / RUN_SEQUENCE_SPAN) + 1
  if (event.kind === 'response.committed') {
    if(event.data['publicTextSources']!==undefined){
      if(event.data['publicTextPartId']!==undefined)throw new Error('ambiguous committed answer sources')
      next=commitAnswerSources(next,event.data['publicTextSources'],event.data['resultId'],event.data['requestVersion'],fence)
    }else next=associatePublicText(next,event.data['publicTextPartId'],event.data['resultId'],event.data['requestVersion'],fence)
  }
  if (fence < view.fence) return next
  next.fence = fence
  if (event.kind === 'run.started' && fence > view.messageFence) {
    next.draft = ''
    next.preview = null
    next.goalOutcome = null
    next.lifecycle = 'leased'
  }
  if (event.kind === 'model.delta' && event.data['partType'] === 'text' && typeof event.data['delta'] === 'string' && fence > view.messageFence
    && (typeof event.data['requestVersion'] === 'number' && event.data['requestVersion'] >= view.requestVersion
      || event.data['requestVersion'] === undefined && view.requestVersion <= 1)) {
    next.draft = ((next.preview ? '' : next.draft) + event.data['delta']).slice(-200_000)
    if (typeof event.data['requestVersion'] === 'number') next.requestVersion = event.data['requestVersion']
    next.preview = null
  }
  if (event.kind === 'response.committed') { next.draft = ''; next.preview = null; next.previewClosedFence = fence }
  if (fence > view.messageFence && isGoalOutcome(event.data['goalOutcome']) && event.data['goalOutcome'].requestVersion >= view.requestVersion) {
    next.goalOutcome = structuredClone(event.data['goalOutcome'])
    next.requestVersion = next.goalOutcome.requestVersion
    if (['awaiting_input','awaiting_approval','delegated'].includes(next.goalOutcome.status)) { next.draft = ''; next.lifecycle = 'waiting' }
  }
  if (event.kind === 'run.failed' || event.kind === 'run.cancelled') {
    next.lifecycle = event.kind === 'run.failed' ? 'failed' : 'cancelled'
    next.draft = ''; next.preview = null; next.previewClosedFence = fence
  }
  return settlePublicText(next)
}

/** Call only for messages received from the product's committed-message channel. */
export function consumeAssistantMessage(view: RunView, message: AssistantMessage, commit: { resultId: string; fence: number }): RunView {
  if (!message || typeof message !== 'object' || 'data' in message || message.version !== 2 || message.runId !== view.runId || typeof message.body !== 'string' || !message.body.trim()) {
    throw new Error('invalid committed assistant message')
  }
  if (!message.envelope || message.envelope.version !== 1 || !isGoalOutcome(message.envelope.goalOutcome)
    || !Array.isArray(message.envelope.citations) || !Array.isArray(message.envelope.artifacts)
    || message.envelope.body !== message.body || message.envelope.requestVersion !== message.envelope.goalOutcome.requestVersion) {
    throw new Error('committed message has an inconsistent envelope')
  }
  if (!commit?.resultId || !Number.isSafeInteger(commit.fence) || commit.fence < 1) throw new Error('committed result identity is required')
  if(message.publicTextSources!==undefined){
    if(message.publicTextPartId!==undefined)throw new Error('ambiguous committed answer sources')
    view=commitAnswerSources(view,message.publicTextSources,commit.resultId,message.envelope.requestVersion,commit.fence,message.body)
  }
  view=associatePublicText(view,message.publicTextPartId,commit.resultId,message.envelope.requestVersion,commit.fence)
  if (view.message && commit.fence === view.messageFence && commit.resultId === view.resultId) return view
  if (message.envelope.requestVersion < view.requestVersion || commit.fence < view.messageFence
    || commit.fence === view.messageFence && view.resultId !== commit.resultId) return view
  const current = commit.fence >= view.fence
  return { ...view, message: structuredClone(message), messageFence: commit.fence, resultId: commit.resultId,
    requestVersion: Math.max(view.requestVersion,message.envelope.requestVersion),
    ...current ? { draft: '', preview: null, previewClosedFence: commit.fence, fence: commit.fence, goalOutcome: structuredClone(message.envelope.goalOutcome),
      lifecycle: message.envelope.goalOutcome.status === 'satisfied' ? 'succeeded' : ['partial','blocked'].includes(message.envelope.goalOutcome.status)
        ? message.envelope.goalOutcome.status as 'partial' | 'blocked' : 'waiting' } : {} }
}

export interface PublicAnswerSegmentView {
  messageId:string
  segmentId:string
  partId:string
  text:string
  status:'streaming'|'sealed'|'pending-replacement'|'accepted'|'replaced'|'incomplete'
  operation:'append'|'replace'
  supersedes:readonly string[]
  /** UTF-16 offsets in the one outer-trimmed active answer; archives use 0/0. */
  start:number
  end:number
  requestVersion:number
  fence:number
  bodyHash?:string
}
/** Read-only display projection. Pending replacements never alter the active body. */
export function publicAnswerSegments(view:RunView):PublicAnswerSegmentView[]{
  const version=Math.max(view.requestVersion,...(view.publicTextParts??[]).filter(part=>part.version===3).map(part=>part.requestVersion)),messageId=answerMessageId(view.runId,version)
  const parts=(view.publicTextParts??[]).filter(part=>part.version===3&&part.requestVersion===version&&part.messageId===messageId).toSorted((a,b)=>a.firstSeq-b.firstSeq)
  const fromPart=(part:PublicTextPart,status:PublicAnswerSegmentView['status'],text=part.text,start=0,end=0):PublicAnswerSegmentView=>({
    messageId,segmentId:part.segmentId!,partId:part.partId,text,status,operation:part.operation!,supersedes:[...part.supersedes??[]],start,end,requestVersion:version,fence:part.fence,...part.bodyHash?{bodyHash:part.bodyHash}:{}})
  const commit=view.publicTextCommit?.requestVersion===version?view.publicTextCommit:undefined
  let body:string|undefined
  if(commit){
    body=view.message?.publicTextSources&&view.resultId===commit.resultId&&view.message.envelope.requestVersion===version?view.message.body:undefined
    validateAnswerSources(view,commit.sources,version,commit.fence,body)
    if(body===undefined&&commit.sources.segments.every(source=>parts.some(part=>part.partId===source.partId&&part.sealedSeq&&part.bodyHash===source.bodyHash)))
      body=commit.sources.segments.map(source=>parts.find(part=>part.partId===source.partId)!.text).join('').trim()
  }
  if(commit&&body!==undefined){
    const selected=new Set(commit.sources.segments.map(source=>source.partId))
    return [...commit.sources.segments.map(source=>{
      const part=parts.find(part=>part.partId===source.partId)
      return {messageId,segmentId:source.segmentId,partId:source.partId,text:body.slice(source.start,source.end),status:'accepted' as const,
        operation:part?.operation??(source.partId===source.segmentId?'append':'replace'),supersedes:[...part?.supersedes??[]],
        start:source.start,end:source.end,requestVersion:version,fence:part?.fence??commit.fence,bodyHash:source.bodyHash}
    }),...parts.filter(part=>!selected.has(part.partId)).map(part=>fromPart(part,part.operation==='replace'
      &&!commit.sources.segments.some(source=>source.segmentId===part.segmentId)?'pending-replacement':'replaced'))]
  }
  // An unsealed failed append has no valid body to displace. A correction can
  // stream into that same logical slot; repairs of sealed sources remain held
  // until the authoritative commit. Never infer lineage from matching text.
  const byId=new Map(parts.map(part=>[part.partId,part])),slots=new Map<string,PublicTextPart>()
  const failedAppendRoot=(part:PublicTextPart):PublicTextPart|undefined=>{
    if(part.operation==='append')return part
    if(part.supersedes?.length!==1)return undefined
    const target=byId.get(part.supersedes[0]!)
    if(!target||target.firstSeq>=part.firstSeq||target.endedSeq===null||target.endedSeq>=part.firstSeq||target.reason!=='failed'||target.sealedSeq
      ||target.segmentId!==part.segmentId||target.fence>part.fence)return undefined
    return failedAppendRoot(target)
  }
  for(const part of parts){const root=failedAppendRoot(part);if(root)slots.set(root.partId,part)}
  const active=[...slots.values()],activeIds=new Set(active.map(part=>part.partId))
  const raw=active.map(part=>part.text).join(''),trimmed=raw.trim(),left=raw.length-raw.trimStart().length
  let offset=0
  return [...active.map(part=>{
    const start=Math.max(0,Math.min(trimmed.length,offset-left));offset+=part.text.length
    const end=Math.max(start,Math.min(trimmed.length,offset-left))
    return fromPart(part,part.sealedSeq?'sealed':part.status==='incomplete'||part.endedSeq!==null?'incomplete':'streaming',trimmed.slice(start,end),start,end)
  }),...parts.filter(part=>!activeIds.has(part.partId)).map(part=>fromPart(part,failedAppendRoot(part)?'replaced':'pending-replacement'))]
}

/** Use a consistent public readRunState snapshot after replay and after every control operation. */
export function consumeRunState(view: RunView, state: RunState): RunView {
  const { run } = state
  if (run.id===view.runId && state.publicTextAttempts) view=consumePublicTextAttempts(view,state.publicTextAttempts)
  if (run.id !== view.runId || run.requestVersion < view.requestVersion || run.fence < view.fence) return view
  if (run.fence === view.messageFence && (run.resultFence ?? 0) < view.messageFence) return view
  let next = view
  if (state.message && run.resultId && run.resultFence) next = consumeAssistantMessage(next,state.message,{ resultId: run.resultId, fence: run.resultFence })
  return settlePublicText({ ...next, fence: run.fence, requestVersion: run.requestVersion, lifecycle: run.status,
    goalOutcome: run.goalOutcome, delivery: state.delivery,
    ...!['queued','leased'].includes(run.status) ? { previewClosedFence: run.fence } : {},
    ...['queued','leased'].includes(run.status) && run.fence === view.fence && run.requestVersion === view.requestVersion
      ? {} : { draft: '', preview: null } })
}

/** Gaps discard the draft; reconnect the SSE source to obtain a complete snapshot. */
export function consumePreview(view: RunView, update: PreviewUpdate): RunView {
  if (update.runId !== view.runId || update.fence < view.fence || update.fence <= view.messageFence
    || update.fence <= (view.previewClosedFence ?? 0) || update.requestVersion < view.requestVersion
    || !Number.isSafeInteger(update.seq) || update.seq < 1) return view
  const prior = view.preview
  if (prior?.fence === update.fence && update.seq <= prior.seq) return view
  const draft = update.kind === 'snapshot' ? update.draft
    : prior?.attemptId === update.attemptId && prior.fence === update.fence
      && prior.requestVersion === update.requestVersion && prior.seq === update.fromSeq ? view.draft + update.delta : null
  if (draft === null || draft.length > 100_000) return { ...view, draft: '', preview: null }
  return { ...view, draft, fence: update.fence, requestVersion: update.requestVersion,
    preview: { attemptId: update.attemptId, seq: update.seq, fence: update.fence, requestVersion: update.requestVersion } }
}

export function consumeRunStreamEvent(view: RunView, item: RunStreamEvent): RunView {
  switch (item.type) {
    case 'trace': return view // Trace is optional presentation metadata, never message content.
    case 'event': return consumeRunEvent(view, item.event)
    case 'state': return consumeRunState(view, item.state)
    case 'preview': return consumePreview(view, item.preview)
    case 'reset': return item.runId === view.runId ? { ...view, draft: '', preview: null } : view
  }
}

export type { GoalOutcome } from '../protocol/outcome.js'

export type ResponseSegment = { type: 'text'; text: string } | { type: 'citation'; text: string; annotation: CitationAnnotation }
  | { type: 'presentation'; component: import('../presentation/definition.js').TrustedPresentation }

/** Text values are display data; callers must not insert them as raw HTML. */
export function responseSegments(envelope: ResponseEnvelope): ResponseSegment[] {
  const segments: ResponseSegment[] = []
  const evidence = envelope.citationEvidence === undefined ? undefined : snapshotCitationEvidence(envelope.citationEvidence)
  const cited = new Set<string>()
  let offset = 0
  for (const annotation of envelope.citations) {
    if (!Number.isSafeInteger(annotation.start) || !Number.isSafeInteger(annotation.end)
      || annotation.start < offset || annotation.end <= annotation.start || annotation.end > envelope.body.length) {
      throw new Error('invalid citation span')
    }
    if (evidence) {
      const link = /^\[([^\]\n]+)\]\(#cite-(S[1-9]\d*(?:,S[1-9]\d*)*)\)$/.exec(envelope.body.slice(annotation.start, annotation.end))
      if (!link || link[1] !== annotation.text || [...new Set(link[2]!.split(','))].join(',') !== annotation.markers.join(',')) {
        throw new Error('citation text does not match its Markdown span')
      }
      const sources = citationSources(annotation.markers, evidence)
      if (annotation.support !== 'not_assessed' || sources.length !== annotation.sources.length || sources.some((source, index) => {
        const recorded = annotation.sources[index]!
        return source.sourceId !== recorded.sourceId || source.sourceVersion !== recorded.sourceVersion
          || source.truncated !== recorded.truncated || JSON.stringify(source.chunkIds) !== JSON.stringify(recorded.chunkIds)
      })) throw new Error('citation excerpts do not match recorded sources')
      for (const marker of annotation.markers) cited.add(marker)
    }
    if (annotation.start > offset) segments.push({ type: 'text', text: envelope.body.slice(offset, annotation.start) })
    segments.push({ type: 'citation', text: annotation.text, annotation: structuredClone(annotation) })
    offset = annotation.end
  }
  if (evidence?.some(item => !cited.has(item.marker))) throw new Error('unreferenced citation evidence')
  if (offset < envelope.body.length) segments.push({ type: 'text', text: envelope.body.slice(offset) })
  for (const component of envelope.presentations ?? []) segments.push({ type: 'presentation', component: structuredClone(component) })
  return segments
}
