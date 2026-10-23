import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { abortable } from '../deadline.js'
import { authorizeConversationWork } from '../collaboration/access.js'
import { publicTextPayload, type PublicTextEndReason } from '../protocol/public-text.js'
import type { WorkItem } from '../protocol/types.js'
import type { StoredRunEvent, StoreLeaseProof } from '../control-plane/stores.js'
import { withTransaction, workItemFromRow, type SqlPool, type SqlQueryable } from '../control-plane/pg-store.js'
import { withRuntimeOperation } from './operation-context.js'

export interface PublicTextAuthorizationContext {
  database: SqlQueryable
  signal: AbortSignal
  /** Absolute Unix milliseconds; all authorization queries share this deadline. */
  deadlineMs: number
}
export type PublicTextPolicy = (work: Omit<WorkItem,'leaseToken'>, requestVersion: number,
  context: PublicTextAuthorizationContext) => boolean | Promise<boolean>
export interface PublicTextAttempt { fence: number; reason: PublicTextEndReason }

async function bounded<T>(pool:SqlPool, body:(context:PublicTextAuthorizationContext)=>Promise<T>):Promise<T>{
  const deadlineMs=Date.now()+3000,signal=AbortSignal.timeout(3000)
  return withRuntimeOperation(pool,{signal,deadlineAt:new Date(deadlineMs).toISOString()},db=>
    withTransaction(db,database=>body({database,signal,deadlineMs})))
}
async function allowed(policy:PublicTextPolicy|undefined, work:Omit<WorkItem,'leaseToken'>,version:number,context:PublicTextAuthorizationContext){
  if(!policy||work.conversation?.internal)return false
  await authorizeConversationWork(context.database,work,'speak',true)
  return await abortable(Promise.resolve(policy(work,version,context)),context.signal)===true
}
export function publicTextPublication(pool:SqlPool,policy:PublicTextPolicy|undefined){
  return {
    async allowed(work:Omit<WorkItem,'leaseToken'>,version:number){
      if(!policy||work.conversation?.internal)return false
      return bounded(pool,context=>allowed(policy,work,version,context))
    },
    async append(event:StoredRunEvent,proof:StoreLeaseProof|undefined,work:Omit<WorkItem,'leaseToken'>|undefined,
      append:(database:SqlQueryable)=>Promise<boolean>){
      const data=publicTextPayload(event)
      if(!data||!proof||!work||!policy)throw new Error('public text publication is not enabled')
      return bounded(pool,async context=>{
        const {database}=context
        const row=(await database.query(`SELECT *,jsonb_array_length(steer_inputs)+1 AS request_version FROM lingxios.agent_work_items
          WHERE id=$1 AND fence=$2 AND lease_token_hash=$3 AND status='leased' AND lease_expires_at>NOW() FOR UPDATE`,
          [work.id,proof.fence,proof.leaseTokenHash])).rows[0]
        if(!row)throw new Error('public text lease is no longer current')
        const duplicate=(await database.query('SELECT kind,stage,visibility,data FROM lingxios.agent_run_events WHERE run_id=$1 AND seq=$2',[event.runId,event.seq])).rows[0]
        if(duplicate){
          if(duplicate['kind']!==event.kind||duplicate['stage']!==event.stage||duplicate['visibility']!==event.visibility||!isDeepStrictEqual(duplicate['data'],event.data))throw new Error('conflicting public text replay')
          return false
        }
        if(row['cancel_requested_at']||Number(row['request_version'])!==data.requestVersion||data.fence!==proof.fence)throw new Error('public text request is no longer current')
        const current=workItemFromRow(row,'',1)
        if(!await allowed(policy,current,data.requestVersion,context))throw new Error('public text publication is not authorized')
        const prior=(await database.query(`SELECT kind,data FROM lingxios.agent_run_events WHERE run_id=$1
          AND kind IN ('public.text.operation','public.text.delta','public.text.ended','public.text.sealed') AND data->>'partId'=$2 ORDER BY seq DESC LIMIT 1`,[event.runId,data.partId])).rows[0]
        const previous=prior?.['data'] as Record<string,unknown>|undefined
        if(previous&&['version','purpose','requestVersion','fence','attemptId','partIndex','messageId','segmentId','operation','supersedes'].some(key=>!isDeepStrictEqual(previous[key],Reflect.get(data,key))))throw new Error('public text identity changed')
        if(event.kind==='public.text.operation'){
          if(prior)throw new Error('answer operation already exists')
          return append(database)
        }
        if(data.version===3&&!prior)throw new Error('answer operation must precede text')
        if(event.kind==='public.text.sealed'){
          if(prior?.['kind']!=='public.text.ended'||!['completed','tool'].includes(String(previous?.['reason']))
            ||!('bodyHash' in data)||data.chunkCount!==previous?.['chunkCount'])throw new Error('only a complete answer segment can be sealed')
          const chunks=(await database.query(`SELECT data->>'text' AS text FROM lingxios.agent_run_events WHERE run_id=$1
            AND kind='public.text.delta' AND data->>'partId'=$2 ORDER BY seq`,[event.runId,data.partId])).rows
          const text=chunks.map(row=>String(row['text'])).join('')
          if(!text||chunks.length!==data.chunkCount||createHash('sha256').update(text).digest('hex')!==data.bodyHash)throw new Error('answer seal does not match durable text')
          const inserted=await append(database)
          if(!inserted)throw new Error('answer seal sequence already exists')
          const input={...data,sealedSeq:event.seq}, stepId='sealed:'+createHash('sha256').update(data.partId).digest('hex')
          // The event and recovery record share the same authorized lease transaction.
          await database.query(`INSERT INTO lingxios.agent_steps(work_id,step_id,request_version,kind,input_hash,input,output,artifacts,completed_at)
            VALUES($1,$2,$3,'runtime.answer_segment',$4,$5::jsonb,$6::jsonb,'[]'::jsonb,NOW())`,
          [work.id,stepId,data.requestVersion,createHash('sha256').update(JSON.stringify(input)).digest('hex'),JSON.stringify(input),JSON.stringify(JSON.stringify({text}))])
          return true
        }
        if(prior?.['kind']==='public.text.ended'||prior?.['kind']==='public.text.sealed')throw new Error('public text part is already closed')
        const chunks=previous&&prior?.['kind']!=='public.text.operation'?Number(previous['chunkIndex'])+1:0
        if('text' in data?data.chunkIndex!==chunks:!('chunkCount' in data)||!chunks||data.chunkCount!==chunks)throw new Error('public text chunk sequence is incomplete')
        return append(database)
      })
    },
  }
}
/** At most one bounded event page's fences; never aggregate or truncate a run's history. */
export async function readPublicTextAttempts(database:SqlQueryable,runId:string,fences:readonly number[]):Promise<PublicTextAttempt[]>{
  const selected=[...new Set(fences)]
  if(selected.length>100)throw new Error('public text attempt page exceeds limit')
  if(!selected.length)return []
  const {rows}=await database.query(`SELECT a.fence,CASE
    WHEN a.fence=w.fence AND w.cancel_requested_at IS NOT NULL THEN 'cancelled'
    WHEN a.reason IN ('failed','cancelled') THEN a.reason WHEN a.reason='queued' THEN 'superseded'
    ELSE 'interrupted' END AS reason
    FROM lingxios.agent_attempts a JOIN lingxios.agent_work_items w ON w.id=a.work_id
    WHERE a.work_id=$1 AND a.fence=ANY($2::bigint[]) AND (a.ended_at IS NOT NULL OR (a.fence=w.fence AND w.cancel_requested_at IS NOT NULL)) ORDER BY a.fence`,[runId,selected])
  return rows.map(row=>({fence:Number(row['fence']),reason:row['reason'] as PublicTextEndReason}))
}
