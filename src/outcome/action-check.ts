import { isDeepStrictEqual } from 'node:util'
import type { SqlQueryable } from '../control-plane/pg-store.js'
import type { ActionExecutor } from '../control-plane/stores.js'
import type { HostAction, HostActionResult, WorkItem } from '../protocol/types.js'
import type { ToolDefinition } from '../tools/catalog.js'
import type { VerificationRecord } from './verification.js'

export async function candidateActions(database: SqlQueryable, work: Pick<WorkItem, 'id' | 'tenantId' | 'principalId' | 'agentId' | 'sessionId' | 'threadId'>, requestVersion: number,
  tools: readonly ToolDefinition[]) {
  const { rows } = await database.query(`SELECT intent.idempotency_key,intent.intent->'action' AS action,
      COALESCE(resolved.result,receipt.result) AS result
    FROM lingxios.agent_action_intents intent
    LEFT JOIN lingxios.agent_action_ledger receipt USING(idempotency_key)
    LEFT JOIN LATERAL (SELECT resolution->'result' AS result FROM lingxios.agent_action_resolutions
      WHERE idempotency_key=intent.idempotency_key ORDER BY resolution_seq DESC LIMIT 1) resolved ON TRUE
    WHERE intent.intent->>'workId'=$1 AND (intent.intent->>'requestVersion')::integer=$2
      AND intent.intent->>'tenantId'=$4 AND intent.intent->>'principalId' IS NOT DISTINCT FROM $5
      AND intent.intent->>'agentId'=$6 AND intent.intent->>'sessionId'=$7
      AND intent.intent->>'threadId' IS NOT DISTINCT FROM $8
      AND intent.intent->'action'->>'action' NOT LIKE 'task.%' AND intent.intent->'action'->>'action' NOT LIKE 'graph.%'
      AND NOT (intent.intent->'action'->>'action'=ANY($3::text[]))
    ORDER BY intent.recorded_at,intent.idempotency_key LIMIT 1025`,
  [work.id,requestVersion,tools.filter(tool => tool.effect === 'read').map(tool => tool.action),
    work.tenantId,work.principalId ?? null,work.agentId,work.sessionId,work.threadId ?? null])
  return rows.map(row => ({ key: String(row['idempotency_key']), action: row['action'] as HostAction,
    result: row['result'] as HostActionResult | null }))
}

export async function inspectActions(database: SqlQueryable, work: Omit<WorkItem, 'leaseToken'>,
  requestVersion: number, tools: readonly ToolDefinition[], executor?: ActionExecutor): Promise<VerificationRecord[]> {
  const actions = await candidateActions(database, work, requestVersion, tools)
  if (actions.length > 1024) return [{ checker: 'actions', status: 'inconclusive', evidence: { reason: 'More than 1024 write actions require verification' } }]
  const records: VerificationRecord[] = []
  for (const { key, action, result } of actions) {
    const checker = `action:${key}`
    if (!result || result.executionState === 'unknown' || result.approval) {
      records.push({ checker, status: 'inconclusive', evidence: { action: action.action, reason: 'Effect requires reconciliation or approval' } })
    } else if (!result.ok) {
      records.push({ checker, status: 'passed', evidence: { action: action.action, scope: 'confirmed_failed_action_without_effect', error: result.error } })
    } else if (!executor?.verifyResult) {
      records.push({ checker, status: 'inconclusive', evidence: { action: action.action, reason: 'Authoritative business readback is unavailable' } })
    } else {
      try { records.push({ checker, ...await executor.verifyResult(work, action, result.value,
        { requestVersion, signal: AbortSignal.timeout(30_000), deadlineAt: new Date(Date.now() + 30_000).toISOString() }) }) }
      catch { records.push({ checker, status: 'inconclusive', evidence: { action: action.action, reason: 'Current authorized resource readback failed' } }) }
    }
  }
  // Work backwards so an intermediate batch first inherits its own later proof.
  // Keep the original readback fields and observations: a promoted batch must
  // still be usable as evidence for earlier batches, with an auditable chain.
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]!, resource = record.evidence['resource']
    if (record.status !== 'failed' || typeof resource !== 'string') continue
    const fields = record.evidence['fields'], missing = record.evidence['mismatches']
    if (!Array.isArray(fields) || !Array.isArray(missing) || !missing.length
      || !missing.every(field => typeof field === 'string' && fields.includes(field))) continue
    const supersededFields: Record<string, string> = {}
    for (const field of missing as string[]) {
      // Only successful effects with authoritative readback may prove a field.
      // Prefer the latest receipt; never infer success from unknown/no-effect writes.
      for (let laterIndex = records.length - 1; laterIndex > index; laterIndex--) {
        const later = records[laterIndex]!, receipt = actions[laterIndex]!.result
        if (!receipt?.ok || receipt.executionState === 'unknown' || receipt.approval || receipt.directive
          || later.status !== 'passed' || later.evidence['resource'] !== resource) continue
        const laterFields = later.evidence['fields']
        if (!Array.isArray(laterFields) || !(laterFields.includes(field) || laterFields.includes('deleted'))) continue
        const before = record.evidence['observed'], after = later.evidence['observed']
        if (before && after && typeof before === 'object' && typeof after === 'object'
          && Object.hasOwn(before, field) && Object.hasOwn(after, field)
          && !isDeepStrictEqual(Reflect.get(before, field), Reflect.get(after, field))) continue
        const inherited = later.evidence['supersededFields'] as Record<string, string> | undefined
        supersededFields[field] = inherited?.[field] ?? later.checker
        break
      }
    }
    if (missing.every(field => Object.hasOwn(supersededFields, field))) {
      record.status = 'passed'
      record.evidence = { ...record.evidence, scope: 'successful_receipt_with_superseded_postconditions',
        supersededBy: [...new Set(Object.values(supersededFields))], supersededFields }
    }
  }
  return records
}
