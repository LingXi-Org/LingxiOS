import { createTaskContract, type TaskContract } from '../context/task-contract.js'
import { citationSources, snapshotCitationEvidence, type CitationEvidence, type EvidenceSnapshot } from '../context/evidence.js'
import { isGoalOutcome, type GoalOutcome } from '../protocol/outcome.js'
import type { KernelArtifact } from '../protocol/types.js'
import type { ResourceCheckRecord } from '../context/resource-checks.js'
import type { GoalAssessment } from './assessment.js'

export interface CitationAnnotation {
  start: number
  end: number
  text: string
  markers: string[]
  sources: Array<{ sourceId: string; sourceVersion: string; chunkIds: string[]; truncated?: true }>
  support: 'not_assessed'
}

export interface ResponseEnvelope {
  /** Filled only by the server during the existing result/outbox transaction. */
  presentations?: import('../presentation/definition.js').TrustedPresentation[]
  version: 1
  body: string
  requestVersion: number
  evidenceSnapshotId: string
  citations: CitationAnnotation[]
  /** Absent on historical results. New results freeze only the excerpts they cite. */
  citationEvidence?: CitationEvidence[]
  artifacts: KernelArtifact[]
  goalOutcome: GoalOutcome
  taskContract?: TaskContract
  resourceChecks?: ResourceCheckRecord[]
  /** Model self-assessment; independent verification is recorded separately. */
  assessment?: GoalAssessment
}

export function snapshotArtifacts(artifacts: readonly KernelArtifact[]): KernelArtifact[] {
  if (!Array.isArray(artifacts) || artifacts.length > 512 || !artifacts.every((item) => item
    && typeof item.path === 'string' && item.path.length > 0 && item.path.length <= 4096
    && !/[\\:\u0000-\u001f\u007f]/.test(item.path) && item.path.split('/').every((part: string) => part !== '' && part !== '.' && part !== '..')
    && Number.isSafeInteger(item.size) && item.size >= 0
    && (item.source === undefined || typeof item.source.ref === 'string' && item.source.ref.length > 0 && item.source.ref.length <= 2000
      && typeof item.source.version === 'string' && item.source.version.length > 0 && item.source.version.length <= 2000)
    && typeof item.mime === 'string' && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(item.sha256))) {
    throw new Error('invalid response artifacts')
  }
  return structuredClone([...new Map(artifacts.map(artifact => [artifact.path, artifact])).values()])
}

export function createResponseEnvelope(body: string, goalOutcome: GoalOutcome, evidence: EvidenceSnapshot, artifacts: readonly KernelArtifact[] = [], taskContract?: TaskContract, resourceChecks?: readonly ResourceCheckRecord[], assessment?: GoalAssessment): ResponseEnvelope {
  if (typeof body !== 'string' || !body.trim() || !isGoalOutcome(goalOutcome)) throw new Error('invalid response envelope')
  const checkedArtifacts = snapshotArtifacts(artifacts)
  if (taskContract !== undefined) {
    const { version, requestVersion, originalInputSha256, ...draft } = taskContract
    if (version !== 1 || requestVersion !== goalOutcome.requestVersion || !/^[a-f0-9]{64}$/.test(originalInputSha256)) throw new Error('invalid response task contract')
    createTaskContract('', requestVersion, draft)
  }
  const citations: CitationAnnotation[] = []
  const pattern = /\[([^\]\n]+)\]\(#cite-(S[1-9]\d*(?:,S[1-9]\d*)*)\)/g
  for (const match of body.matchAll(pattern)) {
    const markers = [...new Set(match[2]!.split(','))]
    const sources = citationSources(markers, evidence.items)
    citations.push({ start: match.index, end: match.index + match[0].length, text: match[1]!, markers, sources, support: 'not_assessed' })
  }
  if (body.replace(pattern, '').includes('#cite-')) throw new Error('malformed citation marker')
  const cited = new Set(citations.flatMap(citation => citation.markers))
  const citationEvidence = snapshotCitationEvidence(evidence.items.filter(item => cited.has(item.marker)))
  return { version: 1, body, requestVersion: goalOutcome.requestVersion, evidenceSnapshotId: evidence.id, citations, citationEvidence,
    artifacts: checkedArtifacts, ...(taskContract ? { taskContract: structuredClone(taskContract) } : {}),
    ...(resourceChecks?.length ? { resourceChecks: structuredClone([...resourceChecks]) } : {}),
    ...(assessment ? { assessment: structuredClone(assessment) } : {}), goalOutcome: structuredClone(goalOutcome) }
}
