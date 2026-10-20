import { abortable } from '../deadline.js'
import type { SqlQueryable } from '../control-plane/pg-store.js'
import type { WorkItem } from '../protocol/types.js'
import type { EmbeddingOptions } from '../model/embeddings.js'
import type { MemoryWritePolicy } from './policy.js'
import type { EvolutionBenchmark } from './evolution.js'
import type { MemoryAllocation, MemoryIdentity, MemoryScope, MemoryScopeGrant } from './types.js'
import { validateScope } from './store.js'
import { authorizeConversationWork, digest } from '../collaboration/access.js'
import { workItemFromRow } from '../control-plane/pg-store.js'

export interface MemoryOptions {
  /** Resolve destinations from the authenticated identity's current product permissions. */
  resolveScopes(identity: MemoryIdentity, database: SqlQueryable, signal?: AbortSignal, operation?: 'read'|'write'|'capture'): Promise<MemoryScopeGrant[]>
  writePolicy?: MemoryWritePolicy
  embeddings?: EmbeddingOptions
  evolution?: {
    benchmarkId: string
    /** Trusted, cloneable definition frozen atomically only when synthesis proposes candidates.
     * Its ID must match benchmarkId. Omit to require prior administrative freezing. */
    benchmark?: EvolutionBenchmark
  }
  contextBudget?: { ratio?: number; maxTokens?: number; concurrency?: number; timeoutMs?: number;
    /** Optional recall is on demand via memory.search; core and authorization stay mandatory. */
    optionalRecall?: boolean; recallTimeoutMs?: number; allocation?: MemoryAllocation }
  reflection?: { afterInteractions?: number; idleMs?: number }
}
export function memorySettings(options: MemoryOptions) {
  const ratio = options.contextBudget?.ratio ?? 0.08, maxTokens = options.contextBudget?.maxTokens ?? 8000
  const concurrency = options.contextBudget?.concurrency ?? 2, timeoutMs = options.contextBudget?.timeoutMs ?? 10_000
  const recallTimeoutMs = options.contextBudget?.recallTimeoutMs ?? Math.min(3000, timeoutMs)
  const afterInteractions = options.reflection?.afterInteractions ?? 5, idleMs = options.reflection?.idleMs ?? 600_000
  const allocation = options.contextBudget?.allocation
  if (allocation && (Object.keys(allocation).sort().join(',') !== 'core,directory,recalled,strategies'
    || Object.values(allocation).some(value => !Number.isFinite(value) || value < 0 || value > 1)
    || Math.abs(Object.values(allocation).reduce((a,b) => a+b,0)-1)>0.000001
    || allocation.core<=0 || allocation.recalled<=0)) throw new Error('invalid memory allocation')
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 0.25 || !Number.isSafeInteger(maxTokens) || maxTokens < 512 || maxTokens > 32_000
    || !Number.isSafeInteger(afterInteractions) || afterInteractions < 1 || afterInteractions > 20
    || !Number.isSafeInteger(idleMs) || idleMs < 1000 || idleMs > 86_400_000
    || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000
    || !Number.isSafeInteger(recallTimeoutMs) || recallTimeoutMs < 10 || recallTimeoutMs > timeoutMs) throw new Error('invalid memory budget or reflection configuration')
  return { ratio,maxTokens,afterInteractions,idleMs,concurrency,timeoutMs,recallTimeoutMs }
}
export function identityOf(work: Omit<WorkItem,'leaseToken'>): MemoryIdentity {
  if (!work.principalId) throw new Error('memory requires an authenticated principal')
  return { tenantId: work.tenantId,agentId: work.agentId,principalId: work.principalId,sessionId: work.sessionId,
    workId: work.id,...work.threadId === undefined ? {} : { threadId: work.threadId } }
}
export function sourceIdentity(row: Record<string, unknown>): MemoryIdentity {
  return { tenantId: String(row['tenant_id']),agentId: String(row['agent_id']),principalId: String(row['principal_id']),
    sessionId: String(row['session_id']),workId: String(row['source_run_id'] ?? row['id']),
    ...row['thread_id'] == null ? {} : { threadId: String(row['thread_id']) } }
}
export function sameScope(a: MemoryScope,b: MemoryScope): boolean {
  return a.tenantId === b.tenantId && a.scopeType === b.scopeType && a.scopeId === b.scopeId
}
export function legacyMemoryScope(memory: MemoryScope, work: Omit<WorkItem,'leaseToken'>): MemoryScope {
  const scope = work.conversation
  return { tenantId: memory.tenantId,scopeType: memory.scopeType,scopeId: scope ? 'im-memory:' + digest([memory.scopeType,memory.scopeId,
    scope.conversationId,work.threadId ?? null,work.agentId,work.principalId,scope.audience,scope.policyVersion]) : memory.scopeId }
}
export async function authorizedScopes(options: MemoryOptions, identity: MemoryIdentity, database: SqlQueryable, external?: AbortSignal, operation: 'read' | 'write' | 'capture' = 'read'): Promise<MemoryScope[]> {
  if (![identity.tenantId,identity.agentId,identity.principalId,identity.sessionId].every(value => typeof value === 'string' && value.trim() && value.length<=1000)) throw new Error('invalid memory identity')
  const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...external ? [external] : []])
  signal.throwIfAborted()
  const grants = await abortable(options.resolveScopes(identity,database,signal,operation),signal)
  if (!Array.isArray(grants) || grants.length > 12) throw new Error('too many memory scopes')
  for (const scope of grants) {
    validateScope(scope)
    if (scope.continuity !== undefined
      && !['principal','principal_course','course_shared','agent'].includes(scope.continuity)) throw new Error('invalid memory grant')
    if (scope.readOnly !== undefined && typeof scope.readOnly !== 'boolean'
      || scope.explicitOnly !== undefined && typeof scope.explicitOnly !== 'boolean') throw new Error('invalid memory grant constraint')
  }
  let work: Omit<WorkItem,'leaseToken'> | undefined
  if (identity.workId) {
    const row = (await database.query('SELECT * FROM lingxios.agent_work_items WHERE id=$1', [identity.workId])).rows[0]
    if (row?.['conversation']) {
      work = workItemFromRow(row, '', 1)
      if (work.tenantId !== identity.tenantId || work.principalId !== identity.principalId || work.agentId !== identity.agentId
        || work.sessionId !== identity.sessionId || work.threadId !== identity.threadId) throw new Error('IM memory identity differs from its run')
      await authorizeConversationWork(database, work, 'read')
    }
  }
  const scopes: MemoryScope[] = []
  for (const grant of grants) {
    if (operation !== 'read' && (grant.readOnly || operation === 'capture' && grant.explicitOnly)) continue
    if (!grant.continuity) { scopes.push(work ? legacyMemoryScope(grant,work) : { tenantId: grant.tenantId,scopeType: grant.scopeType,scopeId: grant.scopeId }); continue }
    // A private profile may enter only the principal/current Agent's audience.
    // Product membership is checked by the resolver; native policy independently
    // prevents a trusted resolver mistake from leaking personal facts to a group.
    if (work?.conversation && ['principal','principal_course','agent'].includes(grant.continuity)
      && (work.conversation.internal || work.conversation.audience.participantIds.some(id => id !== identity.principalId && id !== identity.agentId))) continue
    const owner = grant.continuity === 'course_shared' ? null : grant.continuity === 'agent' ? identity.agentId : identity.principalId
    scopes.push({ tenantId: grant.tenantId,scopeType: grant.scopeType,
      scopeId: 'stable-memory:' + digest([grant.continuity,grant.scopeType,grant.scopeId,owner]) })
  }
  const keys = new Set<string>()
  for (const scope of scopes) {
    validateScope(scope)
    const key = JSON.stringify([scope.tenantId,scope.scopeType,scope.scopeId])
    if (scope.tenantId !== identity.tenantId || keys.has(key)) throw new Error('invalid authorized memory scope')
    keys.add(key)
  }
  return scopes
}
export async function authorizeScope(options: MemoryOptions, identity: MemoryIdentity, database: SqlQueryable, scope: MemoryScope, operation: 'read' | 'write' = 'read'): Promise<void> {
  validateScope(scope)
  if (!(await authorizedScopes(options,identity,database,undefined,operation)).some(item => sameScope(item,scope))) throw new Error('memory scope was revoked')
}
