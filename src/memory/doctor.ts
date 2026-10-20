import { posix } from 'node:path'
import type { SqlQueryable } from '../control-plane/pg-store.js'
import { listMemories, scopeParams } from './store.js'
import { memoryDigest, validateMemoryPath } from './text.js'
import type { MemoryDiagnostics, MemoryScope } from './types.js'

/** Bounded pages for detailed checks; the core size is an aggregate over the whole scope. */
export async function diagnoseMemory(database: SqlQueryable,scope: MemoryScope,budgetTokens: number,cursor?: string): Promise<MemoryDiagnostics> {
  const page = await listMemories(database,scope,{ limit: 64,includeInactive: true,...cursor===undefined?{}:{cursor} })
  const coreBytes = Number((await database.query(`SELECT COALESCE(SUM(octet_length(body)+octet_length(title)+octet_length(description)),0) AS bytes
    FROM lingxios.agent_memories WHERE tenant_id=$1 AND scope_type=$2 AND scope_id=$3 AND layer='core' AND origin<>'evolved'
      AND status='active' AND (valid_until IS NULL OR valid_until>NOW())`,scopeParams(scope))).rows[0]!['bytes'])
  const duplicates: string[][]=[],brokenLinks: MemoryDiagnostics['brokenLinks']=[]
  const seen = new Set<string>()
  for (const doc of page.items) {
    const hash = memoryDigest(doc.body.trim())
    if (!seen.has(hash)) {
      const same = (await database.query(`SELECT id FROM lingxios.agent_memories WHERE tenant_id=$1 AND scope_type=$2 AND scope_id=$3
        AND origin<>'evolved' AND status='active' AND body=$4 ORDER BY id LIMIT 64`,[...scopeParams(scope),doc.body])).rows
      if (same.length>1) duplicates.push(same.map(row => String(row['id'])))
      seen.add(hash)
    }
    // Only ordinary relative Markdown links are memory edges; external URLs and anchors are not traversed.
    for (const match of [...doc.body.matchAll(/\[[^\]\n]*\]\(([^\s)]+)\)/g)].slice(0,64)) {
      const target = match[1]!
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) continue
      const path = posix.normalize(posix.join(posix.dirname(doc.path),target.split('#')[0]!))
      try { validateMemoryPath(path) } catch { brokenLinks.push({ path: doc.path,target }); continue }
      const found = await database.query(`SELECT id FROM lingxios.agent_memories WHERE tenant_id=$1 AND scope_type=$2 AND scope_id=$3
        AND path=$4 AND origin<>'evolved' AND status='active' AND (valid_until IS NULL OR valid_until>NOW())`,[...scopeParams(scope),path])
      if (!found.rows.length) brokenLinks.push({ path: doc.path,target })
    }
  }
  const conflicts = (await database.query(`SELECT * FROM lingxios.agent_memory_conflicts WHERE tenant_id=$1 AND scope_type=$2 AND scope_id=$3
    ORDER BY created_at DESC,id LIMIT 64`,scopeParams(scope))).rows.map(row => ({ id: String(row['id']),sourceRunIds: row['source_run_ids'] as string[],
      memoryIds: row['memory_ids'] as string[],reason: String(row['reason']) }))
  const failedReflections = (await database.query(`SELECT id,attempts,error FROM lingxios.agent_work_items WHERE tenant_id=$1 AND kind='memory_synthesis'
    AND meta->>'scopeType'=$2 AND meta->>'scopeId'=$3 AND status='failed' ORDER BY updated_at DESC LIMIT 64`,scopeParams(scope))).rows
    .map(row => ({ id: String(row['id']),attempts: Number(row['attempts']),error: row['error']==null?null:String(row['error']) }))
  const counts=(await database.query(`SELECT COUNT(*) FILTER(WHERE s.status='pending')::integer AS pending,
    COUNT(*) FILTER(WHERE NOT e.source_complete)::integer AS incomplete,
    COUNT(*) FILTER(WHERE s.status='rejected')::integer AS rejected,
    COUNT(*) FILTER(WHERE s.status='pending' AND
      (s.job_id IS NULL OR EXISTS(SELECT 1 FROM lingxios.agent_work_items w WHERE w.id=s.job_id AND w.cancel_requested_at IS NULL
        AND (w.status IN ('queued','leased') OR w.status='failed' AND w.attempts<3))))::integer AS retryable,
    COUNT(*) FILTER(WHERE s.status='processed')::integer AS processed,
    COALESCE(SUM(GREATEST(0,(SELECT COUNT(*) FROM lingxios.agent_memory_evidence_segments p WHERE p.source_run_id=s.source_run_id)-s.segment_cursor)) FILTER(WHERE s.status='pending'),0)::integer AS segments
    FROM lingxios.agent_memory_evidence_scopes s JOIN lingxios.agent_memory_evidence e USING(source_run_id)
    WHERE s.tenant_id=$1 AND s.scope_type=$2 AND s.scope_id=$3 AND s.status<>'superseded'`,scopeParams(scope))).rows[0]!
  return { maintenance:{pendingSources:Number(counts['pending']),incompleteSources:Number(counts['incomplete']),processedSources:Number(counts['processed']),pendingSegments:Number(counts['segments']),
    rejectedSources:Number(counts['rejected']),retryableSources:Number(counts['retryable'])}, coreBytes,budgetTokens,overBudget: coreBytes>budgetTokens,duplicates,brokenLinks,
    expired: page.items.filter(doc => doc.status==='expired' || doc.validUntil && Date.parse(doc.validUntil)<=Date.now()).map(doc => doc.id),
    conflicts,failedReflections,nextCursor: page.nextCursor }
}
