import type { SqlPool } from '../control-plane/pg-store.js'
import type { ControlPlaneService } from '../control-plane/service.js'
import { sessionKeyOf, type HostActionResult, type WorkItem } from '../protocol/types.js'
import { authorizeScope, identityOf, type MemoryOptions } from '../memory/access.js'
import { isMemoryDeletionReceipt, MEMORY_DELETION_CONFIRMATION } from '../memory/confirmation.js'
import { createResponseEnvelope } from '../outcome/envelope.js'

/** Recover the acknowledgment, never the mutation or the pre-forget model context. */
export async function recoverMemoryDeletion(database: SqlPool, service: ControlPlaneService, work: WorkItem,
  options: MemoryOptions, signal?: AbortSignal): Promise<boolean> {
  if (!['turn', 'resume'].includes(work.kind)) return false
  signal?.throwIfAborted()
  const requestVersion = work.requestVersion ?? 1
  const rows = (await database.query(`SELECT i.intent->'action' AS action,l.result
    FROM lingxios.agent_action_intents i JOIN lingxios.agent_action_ledger l USING(idempotency_key)
    WHERE i.intent->>'workId'=$1 AND i.intent->>'tenantId'=$2 AND i.intent->>'agentId'=$3
      AND i.intent->>'sessionId'=$4 AND i.intent->>'principalId' IS NOT DISTINCT FROM $5
      AND i.intent->>'threadId' IS NOT DISTINCT FROM $6 AND (i.intent->>'requestVersion')::integer=$7
      AND i.intent->'action'->>'action' IN ('memory.forget','memory.apply')
      AND l.result->>'ok'='true' AND l.result->>'executionState'='succeeded'
      AND (i.intent->'action'->>'action'='memory.forget'
        OR jsonb_typeof(l.result->'value'->'deleted')='array' AND l.result->'value'->'deleted'<>'[]'::jsonb)
    ORDER BY i.recorded_at,i.idempotency_key LIMIT 1`,
  [work.id,work.tenantId,work.agentId,work.sessionId,work.principalId ?? null,work.threadId ?? null,requestVersion])).rows
  const receipt = rows[0]
  if (!receipt) return false
  const action = receipt['action'] as { action: string; args: { scopeType: string; scopeId: string } }
  if (!isMemoryDeletionReceipt(action.action, receipt['result'] as HostActionResult)) return false
  await authorizeScope(options,identityOf(work),database,
    { tenantId:work.tenantId,scopeType:action.args.scopeType,scopeId:action.args.scopeId },'write')
  const session = await service.getSession(work,sessionKeyOf(work))
  if (!session?.request?.evidence || session.request.workId !== work.id
    || session.request.revisions.length + 1 !== requestVersion) return false
  signal?.throwIfAborted()
  const body = MEMORY_DELETION_CONFIRMATION
  // A deletion receipt proves neither a compound task nor unrelated artifacts.
  // Context-bearing contracts/checks must also stay out of this confirmation.
  await service.commitResult(work,{version:2,runId:work.id,agentId:work.agentId,sessionId:work.sessionId,
    ...(work.threadId === undefined ? {} : {threadId:work.threadId}),body,
    envelope:createResponseEnvelope(body,{status:'partial',verification:'not_run',requestVersion,
      gaps:['Remaining work is unverified after committed memory deletion']},session.request.evidence)},
  { memoryDeletionConfirmation: true })
  return true
}
