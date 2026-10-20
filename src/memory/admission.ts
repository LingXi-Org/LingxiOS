import type { SqlQueryable } from '../control-plane/pg-store.js'
import type { WorkItem } from '../protocol/types.js'
import { authorizedScopes, identityOf, sameScope, type MemoryOptions } from './access.js'
import { lockMemoryScopes, type MemoryEpoch } from './forget.js'
import type { MemoryScope } from './types.js'

/** Read before inventory; the final check is serialized with forget, not the slow retrieval. */
export async function readMemoryEpochs(db: SqlQueryable, scopes: MemoryScope[]): Promise<MemoryEpoch[]> {
  if (!scopes.length) return []
  const rows = (await db.query(`SELECT tenant_id,scope_type,scope_id,epoch,forgotten_at FROM lingxios.agent_memory_scopes
    WHERE (tenant_id,scope_type,scope_id) IN
      (SELECT x->>'tenantId',x->>'scopeType',x->>'scopeId' FROM jsonb_array_elements($1::jsonb) x)`, [JSON.stringify(scopes)])).rows
  return scopes.map(scope => {
    const row = rows.find(row => row['tenant_id']===scope.tenantId && row['scope_type']===scope.scopeType && row['scope_id']===scope.scopeId)
    return {...scope,epoch:Number(row?.['epoch'] ?? 0),forgottenAt:row?.['forgotten_at']==null ? null : new Date(row['forgotten_at'] as string|Date).toISOString()}
  })
}

interface Admission { fence: number; epochs: MemoryEpoch[] }
function equalEpoch(a: MemoryEpoch,b: MemoryEpoch): boolean {
  return sameScope(a,b) && a.epoch===b.epoch && a.forgottenAt===b.forgottenAt
}
async function check(db: SqlQueryable,options: MemoryOptions,work: Omit<WorkItem,'leaseToken'>,epochs: MemoryEpoch[]) {
  const scopes=await authorizedScopes(options,identityOf(work),db)
  if (epochs.some(epoch=>!scopes.some(scope=>sameScope(epoch,scope)))) throw new Error('memory scope was revoked before model admission')
  const current=await lockMemoryScopes(db,epochs)
  if (epochs.some(epoch=>!current.some(value=>equalEpoch(epoch,value)))) throw new Error('memory scope was forgotten before model admission')
}

/** In a short transaction. Only this server-owned context path records epochs;
 * workers request admission with a boolean and cannot supply replacement epochs.
 * Keep the first epoch for every scope across this run, including lease retries. */
export async function rememberMemoryAdmission(db: SqlQueryable,options: MemoryOptions,work: Omit<WorkItem,'leaseToken'>,epochs: MemoryEpoch[]) {
  const row=(await db.query('SELECT fence,meta FROM lingxios.agent_work_items WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[work.id,work.tenantId])).rows[0]
  if (!row || Number(row['fence'])!==work.fence) throw new Error('memory context attempt is stale')
  const previous=(row['meta'] as Record<string,unknown>|null)?.['memoryAdmission'] as Admission|undefined
  const merged=[...previous?.epochs ?? []]
  for (const epoch of epochs) {
    const old=merged.find(value=>sameScope(epoch,value))
    if (old && !equalEpoch(old,epoch)) throw new Error('memory scope was forgotten during this run')
    if (!old) merged.push(epoch)
  }
  await check(db,options,work,merged)
  await db.query(`UPDATE lingxios.agent_work_items SET meta=jsonb_set(COALESCE(meta,'{}'::jsonb),'{memoryAdmission}',$2::jsonb)
    WHERE id=$1`,[work.id,JSON.stringify({fence:work.fence,epochs:merged})])
}

/** The caller already owns the work lock in the model-budget transaction.
 * Commit is admission's linearization point; no lock spans provider I/O. */
export async function admitMemoryModel(db: SqlQueryable,options: MemoryOptions,work: Omit<WorkItem,'leaseToken'>) {
  const admission=work.meta?.['memoryAdmission'] as Admission|undefined
  if (!admission || admission.fence!==work.fence || !Array.isArray(admission.epochs) || !admission.epochs.length) {
    throw new Error('memory model admission has no current context proof')
  }
  await check(db,options,work,admission.epochs)
}
