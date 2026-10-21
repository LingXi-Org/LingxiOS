import type { PublicTextAttempt } from '../app/public-text.js'
export type { PublicTextAttempt } from '../app/public-text.js'
import { publicTextPayload, publicTextStatus, type PublicTextPart, type PublicTextEndReason } from '../protocol/public-text.js'
export type { PublicTextPart, PublicTextEndReason, PublicTextIdentity, PublicTextDelta, PublicTextEnded } from '../protocol/public-text.js'
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
  return {...view,publicTextParts:(view.publicTextParts??[]).map(part=>part.purpose!=='commentary'&&part.partId===partId&&part.requestVersion===requestVersion&&part.fence<=fence
    ? {...part,acceptedResultId:resultId}:part)}
}
function archivePublicText(view: RunView, event: RunEvent): RunView {
  const data = publicTextPayload(event)
  if (!data) return view
  const parts = [...view.publicTextParts ?? []], index = parts.findIndex(part => part.partId === data.partId)
  const prior = parts[index]
  if (prior && ['version','purpose','requestVersion','fence','attemptId','partIndex'].some(key => Reflect.get(prior,key)!==Reflect.get(data,key))) throw new Error('public text identity changed')
  if ('text' in data) {
    if (data.chunkIndex !== (prior?.chunkCount ?? 0)) throw new Error('public text chunk sequence is incomplete')
    const part: PublicTextPart = prior ? { ...prior,text:prior.text+data.text,lastSeq:event.seq,chunkCount:prior.chunkCount+1 }
      : { version:data.version,...(data.purpose?{purpose:data.purpose}:{}),runId:event.runId,requestVersion:data.requestVersion,fence:data.fence,attemptId:data.attemptId,
        partId:data.partId,partIndex:data.partIndex,text:data.text,firstSeq:event.seq,lastSeq:event.seq,chunkCount:1,endedSeq:null,acceptedResultId:null,status:'running',reason:null }
    if (prior) parts[index]=part; else parts.push(part)
  } else {
    if (!prior || prior.chunkCount !== data.chunkCount) throw new Error('public text end is missing its committed chunks')
    parts[index]={ ...prior,lastSeq:event.seq,endedSeq:event.seq,reason:data.reason,status:publicTextStatus(data.reason) }
  }
  const next = { ...view,publicTextParts:parts.sort((a,b)=>a.firstSeq-b.firstSeq) }
  return settlePublicText(view.message ? associatePublicText(next,view.message.publicTextPartId,view.resultId,view.message.envelope.requestVersion,view.messageFence) : next)
}

/** Consume ordered, replayable public events. Draft text is never a committed message. */
export function consumeRunEvent(view: RunView, event: RunEvent): RunView {
  if (event.runId !== view.runId || event.visibility !== 'user' || !Number.isSafeInteger(event.seq) || event.seq <= view.lastSeq) return view
  let next = { ...view, lastSeq: event.seq }
  if (event.kind === 'public.text.delta' || event.kind === 'public.text.ended') return archivePublicText(next,event)
  const fence = Math.floor((event.seq - 1) / RUN_SEQUENCE_SPAN) + 1
  if (event.kind === 'response.committed') next=associatePublicText(next,event.data['publicTextPartId'],event.data['resultId'],event.data['requestVersion'],fence)
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
