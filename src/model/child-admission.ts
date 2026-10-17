import type { SqlQueryable } from '../control-plane/pg-store.js'
import type { WorkItem } from '../protocol/types.js'
import { ModelBudgetExceededError, type BudgetDimension } from '../errors.js'

export interface ChildBudgetAdmission { allowed: boolean; dimension?: BudgetDimension }
export interface AdmissionProfile { inputTokens: number; outputTokens: number; executionMs: number; costMicros: number; inputMicrosPerMillion: number }
export class ChildAdmissionRejectedError extends ModelBudgetExceededError {
  constructor(dimension: BudgetDimension, readonly children: Array<{ id: string; agentId: string }>) {
    super('Child work was not started because the shared root budget cannot cover admission and closing',dimension)
  }
}

/** Caller owns a transaction and has already authorized the parent and target. */
export async function admitChildBudget(db: SqlQueryable, parent: Omit<WorkItem, 'leaseToken'>, version: number | null,
  childId: string, agentId = parent.agentId, assignment = ''): Promise<ChildBudgetAdmission> {
  const rootId = String(parent.meta?.['rootWorkId'] ?? parent.id)
  const requestVersion = Number(parent.meta?.['rootRequestVersion'] ?? version)
  const root = (await db.query(`SELECT id FROM lingxios.agent_work_items WHERE id=$1 AND tenant_id=$2
    AND principal_id IS NOT DISTINCT FROM $3 AND jsonb_array_length(steer_inputs)+1=$4 AND cancel_requested_at IS NULL FOR SHARE`,
  [rootId,parent.tenantId,parent.principalId ?? null,requestVersion])).rows[0]
  if (!root) throw new Error('child budget root request was revoked or superseded')
  await db.query('SELECT root_work_id FROM lingxios.agent_model_budgets WHERE root_work_id=$1 FOR UPDATE',[rootId])
  await db.query(`UPDATE lingxios.agent_model_budgets budget SET deadline_at=NOW()+GREATEST(0,budget.max_execution_ms-COALESCE((
    SELECT SUM(GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(attempt.ended_at,LEAST(NOW(),attempt.lease_expires_at))-attempt.started_at))*1000))
    FROM lingxios.agent_attempts attempt JOIN lingxios.agent_work_items work ON work.id=attempt.work_id
    WHERE COALESCE(work.meta->>'rootWorkId',work.id)=budget.root_work_id),0))*INTERVAL '1 millisecond'
    WHERE root_work_id=$1 AND cumulative_execution`,[rootId])
  const row = (await db.query('SELECT *,EXTRACT(EPOCH FROM (deadline_at-NOW()))*1000 AS remaining_ms FROM lingxios.agent_model_budgets WHERE root_work_id=$1',[rootId])).rows[0]
  const prior = (await db.query('SELECT dimension FROM lingxios.agent_budget_denials WHERE root_work_id=$1 AND request_version=$2 AND proposed_work_id=$3',
    [rootId,requestVersion,childId])).rows[0]
  if (prior) return { allowed: false, dimension: prior['dimension'] as BudgetDimension }
  const existing = await db.query(`SELECT 1 FROM lingxios.agent_model_budget_holds WHERE root_work_id=$1 AND work_id=$2
    UNION ALL SELECT 1 FROM lingxios.agent_work_items WHERE id=$2 AND meta->>'rootWorkId'=$1`,[rootId,childId])
  if (existing.rows.length) return { allowed: true }
  const profile = row?.['child_admission'] as AdmissionProfile | null
  let dimension: BudgetDimension | undefined
  if (!profile) dimension = 'reservation'
  else {
    const held = (await db.query(`SELECT COALESCE(SUM(tokens),0) AS tokens,COALESCE(SUM(cost_micros),0) AS cost,
      COALESCE(SUM(execution_ms),0) AS execution_ms,COUNT(*)::integer AS calls,
      COUNT(*) FILTER(WHERE kind='closing')::integer AS closing FROM lingxios.agent_model_budget_holds WHERE root_work_id=$1`,[rootId])).rows[0]!
    const active = (await db.query(`SELECT COUNT(*)::integer AS count FROM lingxios.agent_work_items
      WHERE meta->>'rootWorkId'=$1 AND status IN ('queued','leased','waiting') AND cancel_requested_at IS NULL`,[rootId])).rows[0]!
    const count = Number(held['closing']) ? 1 : 2, baseTokens = profile.inputTokens+profile.outputTokens
    // Keep the complete observed prompt estimate, maximum output and the new assignment.
    // No empirical byte/token discount: the actual child call must still reserve its full prompt.
    const addedTokens = assignment ? Buffer.byteLength(JSON.stringify(assignment)) : 0
    const tokens = baseTokens+addedTokens, cost = profile.costMicros+Math.ceil(addedTokens*profile.inputMicrosPerMillion/1_000_000)
    dimension = Number(row!['remaining_ms']) < Number(held['execution_ms'])+count*profile.executionMs ? 'deadline'
      : Number(row!['model_calls'])+Number(held['calls'])+count > Number(row!['max_model_calls']) ? 'calls'
      : Number(row!['tokens'])+Number(held['tokens'])+tokens+(count-1)*baseTokens > Number(row!['max_tokens']) ? 'tokens'
      : Number(row!['cost_micros'])+Number(held['cost'])+cost+(count-1)*profile.costMicros > Number(row!['max_cost_micros']) ? 'cost'
      : Number(active['count']) >= 4 ? 'reservation' : undefined
    if (!dimension) {
      for (const [id,kind] of [[rootId,'closing'],[childId,'child']]) {
        await db.query(`INSERT INTO lingxios.agent_model_budget_holds(root_work_id,work_id,kind,tokens,cost_micros,execution_ms)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[rootId,id,kind,kind === 'closing' ? baseTokens : tokens,
            kind === 'closing' ? profile.costMicros : cost,profile.executionMs])
      }
      return { allowed: true }
    }
  }
  await recordChildBudgetDenials(db,parent,version,[{ id: childId,agentId }],dimension)
  return { allowed: false, dimension }
}

/** Also used after a native effect transaction rolls back; caller rechecks the live action. */
export async function recordChildBudgetDenials(db: SqlQueryable, parent: Omit<WorkItem, 'leaseToken'>, version: number | null,
  children: Array<{ id: string; agentId: string }>, dimension: BudgetDimension) {
  const rootId = String(parent.meta?.['rootWorkId'] ?? parent.id), requestVersion = Number(parent.meta?.['rootRequestVersion'] ?? version)
  const current = await db.query(`SELECT id FROM lingxios.agent_work_items WHERE id=$1 AND tenant_id=$2
    AND principal_id IS NOT DISTINCT FROM $3 AND jsonb_array_length(steer_inputs)+1=$4 AND cancel_requested_at IS NULL FOR SHARE`,
  [rootId,parent.tenantId,parent.principalId ?? null,requestVersion])
  if (!current.rows.length) return
  for (const { id: childId,agentId } of children) {
    const inserted = await db.query(`INSERT INTO lingxios.agent_budget_denials(root_work_id,request_version,proposed_work_id,agent_id,dimension)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING proposed_work_id`,[rootId,requestVersion,childId,agentId,dimension])
  if (inserted.rows.length) await db.query(`INSERT INTO lingxios.agent_terminal_outbox
    (root_work_id,request_version,status,reason,not_started_count,not_started_agents)
    VALUES($1,$2,'failed','budget_limit',1,ARRAY[$3::text]) ON CONFLICT(root_work_id,request_version) DO UPDATE SET
      not_started_count=lingxios.agent_terminal_outbox.not_started_count+1,
      not_started_agents=ARRAY(SELECT DISTINCT item FROM unnest(lingxios.agent_terminal_outbox.not_started_agents||EXCLUDED.not_started_agents) item)`,
  [rootId,requestVersion,agentId])
  }
}
