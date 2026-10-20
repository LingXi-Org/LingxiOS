import type { SqlPool } from '../control-plane/pg-store.js'
import { withTransaction, workItemFromRow } from '../control-plane/pg-store.js'
import { authorizedScopes, legacyMemoryScope, sameScope, sourceIdentity, type MemoryOptions } from './access.js'
import { currentMemoryScopes, lockMemoryScopes } from './forget.js'
import { memoryDocument, scopeParams } from './store.js'
import type { MemoryIdentity, MemoryScope } from './types.js'
import { NoEffectError } from '../tools/definition.js'

export interface MemoryMigrationResult {
  items: Array<{ id: string; outcome: 'eligible' | 'migrated' | 'isolated'; reason?: string; from: MemoryScope; to?: MemoryScope }>
  nextCursor: string | null
}

/** Move, never clone. The original id and version history remain one forgetting target. */
export async function migrateLegacyMemory(pool: SqlPool, options: MemoryOptions, identity: MemoryIdentity,
  input: { cursor?: string; limit?: number; dryRun?: boolean } = {}): Promise<MemoryMigrationResult> {
  const limit=input.limit ?? 16
  if(!Number.isSafeInteger(limit) || limit<1 || limit>32 || input.cursor!==undefined && (typeof input.cursor!=='string' || input.cursor.length>1000)) throw new Error('invalid memory migration page')
  return withTransaction(pool,async db=>{
    const current=await authorizedScopes(options,identity,db,undefined,'write')
    const rows=(await db.query(`SELECT * FROM lingxios.agent_memories WHERE tenant_id=$1 AND starts_with(scope_id,'im-memory:')
      AND id>$2 AND origin<>'evolved' AND source_refs @> $3::jsonb ORDER BY id LIMIT $4 FOR UPDATE`,
      [identity.tenantId,input.cursor ?? '',JSON.stringify([{authorId:identity.principalId}]),limit+1])).rows
    const items: MemoryMigrationResult['items']=[]
    for(const row of rows.slice(0,limit)) {
      const doc=memoryDocument(row),from={tenantId:doc.tenantId,scopeType:doc.scopeType,scopeId:doc.scopeId}
      const isolated=(reason:string)=>items.push({id:doc.id,outcome:'isolated',reason,from})
      if(doc.status!=='active' || doc.validUntil && Date.parse(doc.validUntil)<=Date.now()) {isolated('inactive');continue}
      if(!doc.sources.length || doc.sources.some(source=>source.authorId!==identity.principalId || !source.workId)) {isolated('unproven_owner_or_source');continue}
      let target: MemoryScope|undefined,reason: string|undefined
      const sourceIds=[...new Set(doc.sources.map(source=>source.workId!))]
      for(const id of sourceIds) {
        const source=(await db.query('SELECT * FROM lingxios.agent_work_items WHERE id=$1 AND tenant_id=$2 FOR SHARE',[id,identity.tenantId])).rows[0]
        if(!source || source['principal_id']!==identity.principalId || source['cancel_requested_at']) {reason='source_unavailable';break}
        const version=(source['steer_inputs'] as unknown[]).length+1
        if(doc.sources.some(ref=>ref.workId===id && ref.requestVersion!==undefined && ref.requestVersion!==version)) {reason='source_revised';break}
        const actor=sourceIdentity(source),work=workItemFromRow(source,'',1)
        let grants: Awaited<ReturnType<MemoryOptions['resolveScopes']>>,allowed: MemoryScope[]
        try { grants=await options.resolveScopes(actor,db);allowed=await authorizedScopes(options,actor,db,undefined,'write') }
        catch(error) {if(error instanceof NoEffectError) {reason='source_authorization_revoked';break} throw error}
        let destination: MemoryScope|undefined
        for(const grant of grants) {
          if(!['principal','principal_course'].includes(grant.continuity ?? '') || grant.readOnly) continue
          if(!sameScope(legacyMemoryScope(grant.legacyScope ?? grant,work),from)) continue
          const stable=await authorizedScopes({...options,resolveScopes:async()=>[grant]},actor,db,undefined,'write')
          destination=stable.find(candidate=>allowed.some(item=>sameScope(item,candidate)) && current.some(item=>sameScope(item,candidate)))
          if(destination) break
        }
        if(!destination || target && !sameScope(target,destination)) {reason='ownership_or_audience_not_proven';break}
        target=destination
      }
      if(reason || !target) {isolated(reason ?? 'destination_unavailable');continue}
      const epochs=await lockMemoryScopes(db,[from,target])
      let currentSources=true
      for(const id of sourceIds) if((await currentMemoryScopes(db,epochs,id)).length!==epochs.length) currentSources=false
      if(!currentSources) {isolated('source_predates_forgetting');continue}
      const collision=await db.query('SELECT id FROM lingxios.agent_memories WHERE tenant_id=$1 AND scope_type=$2 AND scope_id=$3 AND path=$4',
        [...scopeParams(target),doc.path])
      if(collision.rows.length) {isolated('path_requires_explicit_merge');continue}
      if(input.dryRun) {items.push({id:doc.id,outcome:'eligible',from,to:target});continue}
      await db.query(`INSERT INTO lingxios.agent_memory_scope_moves(tenant_id,memory_id,old_scope_type,old_scope_id,new_scope_type,new_scope_id,source_version,source_epoch,target_epoch)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[identity.tenantId,doc.id,from.scopeType,from.scopeId,target.scopeType,target.scopeId,doc.version,
        epochs.find(item=>sameScope(item,from))!.epoch,epochs.find(item=>sameScope(item,target!))!.epoch])
      await db.query(`UPDATE lingxios.agent_memories SET scope_type=$3,scope_id=$4,version=version+1,updated_at=NOW()
        WHERE tenant_id=$1 AND id=$2`,[identity.tenantId,doc.id,target.scopeType,target.scopeId])
      await db.query('DELETE FROM lingxios.agent_memory_embeddings WHERE tenant_id=$1 AND memory_id=$2',[identity.tenantId,doc.id])
      items.push({id:doc.id,outcome:'migrated',from,to:target})
    }
    return {items,nextCursor:rows.length>limit?String(rows[limit-1]!['id']):null}
  })
}
