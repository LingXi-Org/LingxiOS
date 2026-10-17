import type { SqlQueryable } from '../control-plane/pg-store.js'
import type { DeliveryState, RunIdentity } from './jobs.js'
import { authorizeRunRead } from '../collaboration/api.js'

export const TERMINAL_REASONS = ['context_limit', 'budget_limit', 'model_unavailable', 'permission_denied',
  'dependency_unavailable', 'cancelled', 'interrupted', 'execution_failed'] as const
export type TerminalReason = typeof TERMINAL_REASONS[number]
/** Independent of a successful response/result. Hosts deliver this as a system notification. */
export interface TerminalFeedback {
  id: string
  rootWorkId: string
  requestVersion: number
  status: 'failed' | 'cancelled'
  reason: TerminalReason
  failedCount: number
  cancelledCount: number
  notStartedCount: number
  notStartedAgentIds: string[]
  createdAt: string
  suppressAgentWake: true
}
export function terminalFeedback(row: Record<string, unknown>): TerminalFeedback {
  row = row['delivery_snapshot'] as Record<string, unknown> | null ?? row
  return { id: String(row['id']), rootWorkId: String(row['root_work_id']), requestVersion: Number(row['request_version']),
    status: row['status'] as TerminalFeedback['status'], reason: row['reason'] as TerminalReason,
    failedCount: Number(row['failed_count']), cancelledCount: Number(row['cancelled_count']),
    notStartedCount: Number(row['not_started_count'] ?? 0), notStartedAgentIds: (row['not_started_agents'] as string[] | undefined) ?? [],
    createdAt: new Date(row['created_at'] as Date | string).toISOString(), suppressAgentWake: true }
}

export async function readTerminalFeedback(database: SqlQueryable, identity: RunIdentity): Promise<{
  feedback: TerminalFeedback; delivery: DeliveryState
} | null> {
  await authorizeRunRead(database, identity)
  const { rows } = await database.query(`SELECT notification.* FROM lingxios.agent_work_items work
    JOIN lingxios.agent_terminal_outbox notification ON notification.root_work_id=work.id
      AND notification.request_version=jsonb_array_length(work.steer_inputs)+1
    WHERE work.id=$1 AND work.tenant_id=$2 AND work.agent_id=$3 AND work.session_id=$4
      AND work.principal_id IS NOT DISTINCT FROM $5 AND work.thread_id IS NOT DISTINCT FROM $6`,
  [identity.runId, identity.tenantId, identity.agentId, identity.sessionId, identity.principalId, identity.threadId ?? null])
  const row = rows[0]
  return row ? { feedback: terminalFeedback(row), delivery: row['delivered_at'] ? 'delivered' : row['failed_at'] ? 'failed' : 'pending' } : null
}
