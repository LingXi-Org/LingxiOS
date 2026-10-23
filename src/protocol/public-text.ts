import type { RunEvent } from './types.js'
import { RUN_SEQUENCE_SPAN } from './constants.js'
import { answerMessageId, isBodyHash, snapshotPublicTextOperation, type PublicTextOperation } from './answer-segments.js'

export type PublicTextEndReason = 'completed' | 'tool' | 'failed' | 'cancelled' | 'superseded' | 'interrupted'
export type PublicTextPurpose = 'commentary' | 'answer'
export interface PublicTextIdentity {
  /** v1 has unknown purpose; v2 requires an explicit producer declaration. */
  version: 1 | 2 | 3
  purpose?: PublicTextPurpose
  requestVersion: number
  fence: number
  attemptId: string
  partId: string
  partIndex: number
  messageId?: string
  segmentId?: string
  operation?: PublicTextOperation['kind']
  supersedes?: string[]
}
export interface PublicTextDelta extends PublicTextIdentity { chunkIndex: number; text: string }
export interface PublicTextEnded extends PublicTextIdentity { chunkCount: number; reason: PublicTextEndReason }
export interface PublicTextOperationEvent extends PublicTextIdentity { operation: PublicTextOperation['kind']; supersedes: string[] }
export interface PublicTextSealed extends PublicTextIdentity { chunkCount: number; bodyHash: string }
/** Published commentary, independent of the verified final answer and ephemeral draft. */
export interface PublicTextPart extends PublicTextIdentity {
  runId: string
  text: string
  firstSeq: number
  lastSeq: number
  chunkCount: number
  /** Explicit public.text.ended sequence; null for lifecycle-derived termination. */
  endedSeq: number | null
  /** Set only by a durable committed result explicitly referencing this source part. */
  acceptedResultId: string | null
  status: 'running' | 'complete' | 'incomplete'
  reason: PublicTextEndReason | null
  bodyHash?: string
  sealedSeq?: number
}
const reasons = new Set<PublicTextEndReason>(['completed','tool','failed','cancelled','superseded','interrupted'])
const integer = (value: unknown, min: number) => Number.isSafeInteger(value) && (value as number) >= min
const identifier = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 1000
export function publicTextPayload(event: RunEvent): PublicTextDelta | PublicTextEnded | PublicTextOperationEvent | PublicTextSealed | null {
  if (!['public.text.delta','public.text.ended','public.text.operation','public.text.sealed'].includes(event.kind)) return null
  const d=event.data, delta=event.kind==='public.text.delta', operation=event.kind==='public.text.operation', sealed=event.kind==='public.text.sealed'
  const keys=[...(d['version']!==1?['purpose']:[]),...(d['version']===3?['messageId','segmentId','operation','supersedes']:[]),
    'version','requestVersion','fence','attemptId','partId','partIndex',...(delta?['chunkIndex','text']:sealed?['chunkCount','bodyHash']:operation?[]:['chunkCount','reason'])]
  if(event.visibility!=='user'||![1,2,3].includes(d['version'] as number)||(d['version']!==1&&!['commentary','answer'].includes(d['purpose'] as string))||!integer(d['requestVersion'],1)||!integer(d['fence'],1)
    || d['fence']!==Math.floor((event.seq-1)/RUN_SEQUENCE_SPAN)+1||!identifier(d['attemptId'])||!identifier(d['partId'])
    ||!integer(d['partIndex'],0)||Object.keys(d).some(key=>!keys.includes(key))
    ||(delta? !integer(d['chunkIndex'],0)||typeof d['text']!=='string'||!d['text'].length||new TextEncoder().encode(d['text']).length>16384
      :operation?false:!integer(d['chunkCount'],1)||(sealed?!isBodyHash(d['bodyHash']):!reasons.has(d['reason'] as PublicTextEndReason)))) throw new Error('invalid public text event')
  if(d['version']===3){
    if(d['purpose']!=='answer'||d['messageId']!==answerMessageId(event.runId,Number(d['requestVersion']))||!identifier(d['segmentId'])
      ||d['operation']==='append'&&d['segmentId']!==d['partId'])throw new Error('invalid answer segment identity')
    snapshotPublicTextOperation({kind:d['operation'],supersedes:d['supersedes']})
  }else if(operation||sealed)throw new Error('answer operations require public text v3')
  return d as unknown as PublicTextDelta | PublicTextEnded | PublicTextOperationEvent | PublicTextSealed
}
export function publicTextStatus(reason: PublicTextEndReason): PublicTextPart['status'] {
  return reason==='completed'||reason==='tool'?'complete':'incomplete'
}

/** Trusted synchronous streaming policy. Offsets count UTF-16 code units in text. */
export interface PublicTextSafetyInput {
  text: string
  isFinal: boolean
  approvedThrough: number
}
export interface PublicTextSafetyDecision {
  /** Monotonic approved prefix; the runtime never publishes the uncertain suffix. */
  safeThrough: number
  reject?: 'unsafe_content' | 'unsupported_content'
}
