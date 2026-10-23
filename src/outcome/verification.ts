import { createHash } from 'node:crypto'
import type { KernelArtifact } from '../protocol/types.js'
import { snapshotArtifacts } from './envelope.js'

export interface Candidate {
  body: string
  requestVersion: number
  artifacts: KernelArtifact[]
}
export interface VerificationRecord {
  checker: string
  status: 'passed' | 'failed' | 'inconclusive'
  evidence: Record<string, unknown>
}
/** Trusted product nomination; guidance alone cannot grant or activate capabilities. */
export interface SemanticReviewScope { id: string; rubric: string }
export interface SemanticReviewPolicyIdentity { id: string; version: string }

export function snapshotSemanticReviewScope(value: unknown): SemanticReviewScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'id,rubric'
    || !('id' in value) || typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.id)
    || !('rubric' in value) || typeof value.rubric !== 'string' || !value.rubric.trim()
    || value.rubric.length > 8000 || Buffer.byteLength(value.rubric) > 32_000) throw new Error('invalid semantic review scope')
  return { id: value.id, rubric: value.rubric }
}
/** SHA-256 of the exact rubric bytes; the scope id is bound separately. */
export function semanticReviewScopeHash(scope: SemanticReviewScope): string {
  return createHash('sha256').update(snapshotSemanticReviewScope(scope).rubric).digest('hex')
}
export function snapshotSemanticReviewPolicyIdentity(value: unknown): SemanticReviewPolicyIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'id,version'
    || !('id' in value) || typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.id)
    || !('version' in value) || typeof value.version !== 'string' || !value.version.trim() || value.version.length > 128
    || Buffer.byteLength(value.version) > 512) throw new Error('invalid semantic review policy identity')
  return { id: value.id, version: value.version }
}

export interface CandidateVerification {
  candidateHash: string
  requestVersion: number
  records: VerificationRecord[]
  semanticReview?: SemanticReviewScope
}
export function candidateHash(candidate: Candidate): string {
  return createHash('sha256').update(JSON.stringify({ body: candidate.body,
    artifacts: snapshotArtifacts(candidate.artifacts) })).digest('hex')
}
