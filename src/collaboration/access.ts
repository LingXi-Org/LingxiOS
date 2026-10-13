import { createHash } from 'node:crypto'
import { NoEffectError } from '../tools/definition.js'
import { canonicalJson } from '../context/compiler.js'
import type { SqlQueryable } from '../control-plane/pg-store.js'
import type { WorkItem } from '../protocol/types.js'
import type { Audience, AudienceInput, ConversationCapability, ConversationIdentity, ConversationPolicy } from './types.js'

export const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')
export function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw new Error('invalid collaboration identifier')
}
export function positiveVersion(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('invalid collaboration version')
}
export function identity(input: ConversationIdentity) {
  identifier(input.tenantId); identifier(input.conversationId)
  if (input.threadId !== undefined) identifier(input.threadId)
}
export async function conversationPolicy(database: SqlQueryable, scope: ConversationIdentity, lock = false): Promise<ConversationPolicy> {
  identity(scope)
  const { rows } = await database.query(`SELECT policy FROM lingxios.agent_conversations WHERE tenant_id=$1 AND id=$2${lock ? ' FOR SHARE' : ''}`,
    [scope.tenantId, scope.conversationId])
  if (!rows[0]) throw new NoEffectError('conversation is unavailable', 'forbidden')
  if (scope.threadId !== undefined) {
    const thread = await database.query(`SELECT 1 FROM lingxios.agent_conversation_threads
      WHERE tenant_id=$1 AND conversation_id=$2 AND id=$3`, [scope.tenantId, scope.conversationId, scope.threadId])
    if (!thread.rows.length) throw new NoEffectError('thread is outside this conversation', 'forbidden')
  }
  return rows[0]['policy'] as ConversationPolicy
}
export function participant(policy: ConversationPolicy, id: string, capability: ConversationCapability, kind?: 'human' | 'agent') {
  const entry = policy.participants.find(item => item.id === id && (!kind || item.kind === kind))
  if (!entry?.capabilities.includes(capability)) throw new NoEffectError(`conversation ${capability} capability is unavailable`, 'forbidden')
  return entry
}
export function audienceOf(policy: ConversationPolicy, input: AudienceInput = { visibility: 'conversation' }): Audience {
  if (!input || !['conversation', 'participants'].includes(input.visibility)) throw new Error('invalid audience')
  const ids = input.visibility === 'conversation' ? policy.participants.filter(item => item.capabilities.includes('read')).map(item => item.id) : input.participantIds
  if (!Array.isArray(ids) || !ids.length || ids.length > 256 || new Set(ids).size !== ids.length) throw new Error('invalid audience participants')
  for (const id of ids) { identifier(id); participant(policy, id, 'read') }
  return { visibility: input.visibility, participantIds: [...ids].sort() }
}
export function requireAudience(policy: ConversationPolicy, audience: Audience, ids: string[]) {
  for (const id of ids) {
    participant(policy, id, 'read')
    if (!audience.participantIds.includes(id)) throw new NoEffectError('participant is outside the audience', 'forbidden')
  }
}
/** A resource may feed a result only when all result recipients may see that resource. */
export function containsAudience(resource: Audience, output: Audience) {
  return output.participantIds.every(id => resource.participantIds.includes(id))
}
export async function authorizeConversationWork(database: SqlQueryable, work: Omit<WorkItem, 'leaseToken'>,
  operation: 'read' | 'execute' | 'speak' = 'execute', lock = false) {
  const scope = work.conversation
  if (!scope) return
  const policy = await conversationPolicy(database, { tenantId: work.tenantId, conversationId: scope.conversationId,
    ...(work.threadId === undefined ? {} : { threadId: work.threadId }) }, lock)
  requireAudience(policy, scope.audience, [work.principalId!, work.agentId])
  participant(policy, work.principalId!, operation === 'read' ? 'read' : 'execute', 'human')
  participant(policy, work.agentId, operation === 'read' ? 'read' : 'execute', 'agent')
  // Revoked recipients invalidate old outputs rather than silently changing their audience.
  for (const id of scope.audience.participantIds) participant(policy, id, 'read')
  if (typeof work.meta?.['mentionParentWorkId'] === 'string') {
    if (!policy.agentMentions) throw new NoEffectError('agent mentions are no longer enabled', 'forbidden')
    const lineage = await database.query(`WITH RECURSIVE causes AS (
      SELECT work.*,ARRAY[work.id] AS path FROM lingxios.agent_work_items work WHERE work.id=$1
      UNION ALL SELECT parent.*,child.path||parent.id FROM lingxios.agent_work_items parent
        JOIN causes child ON parent.id=child.meta->>'mentionParentWorkId'
        WHERE parent.tenant_id=$2 AND parent.principal_id=$3 AND NOT parent.id=ANY(child.path) AND cardinality(child.path)<64
    ) SELECT child.meta,parent.id,parent.tenant_id,parent.principal_id,parent.agent_id,parent.conversation,parent.thread_id,parent.cancel_requested_at,
        parent.result_id,parent.fence,result.fence AS result_fence,result.request_version,jsonb_array_length(parent.steer_inputs)+1 AS current_version
      FROM causes child JOIN lingxios.agent_work_items parent ON parent.id=child.meta->>'mentionParentWorkId'
      LEFT JOIN lingxios.agent_results result ON result.id=child.meta->>'mentionResultId'
        AND result.work_id=parent.id WHERE child.meta->>'mentionParentWorkId' IS NOT NULL ORDER BY parent.id${lock ? ' FOR SHARE OF parent' : ''}`,
    [work.id, work.tenantId, work.principalId])
    if (!lineage.rows.length || lineage.rows.length >= 64 || !lineage.rows.some(row => row['id'] === work.meta?.['rootWorkId'])) throw new Error('invalid mention ancestry')
    for (const row of lineage.rows) {
      const parentScope = row['conversation'] as WorkItem['conversation']
      if (row['tenant_id'] !== work.tenantId || row['principal_id'] !== work.principalId
        || !parentScope || parentScope.internal || parentScope.conversationId !== scope.conversationId
        || row['thread_id'] !== (work.threadId ?? null) || !containsAudience(parentScope.audience, scope.audience)
        || row['cancel_requested_at'] || row['result_id'] !== (row['meta'] as Record<string, unknown>)['mentionResultId']
        || row['result_fence'] !== row['fence'] || row['request_version'] !== row['current_version']) throw new NoEffectError('mention cause was cancelled, revised or superseded', 'forbidden')
      participant(policy, String(row['agent_id']), 'speak', 'agent')
    }
  }
  if (operation === 'speak') {
    if (scope.internal || scope.audience.visibility === 'internal') throw new Error('internal work cannot speak')
    participant(policy, work.agentId, 'speak', 'agent')
    const slots = await database.query(`SELECT 1 FROM lingxios.agent_reply_slots WHERE work_id=$1
      AND tenant_id=$2 AND conversation_id=$3 AND message_id=$4 AND message_version=$5 AND agent_id=$6`,
    [work.id, work.tenantId, scope.conversationId, scope.source.messageId, scope.source.version, work.agentId])
    if (!slots.rows.length) throw new Error('work has no reply slot')
  }
  return policy
}
