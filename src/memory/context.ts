import type { MemorySnapshot } from './types.js'
import { excerpt, memoryDigest } from './text.js'

export function snapshotMemories(input: Omit<MemorySnapshot,'id'>): MemorySnapshot {
  return { ...input,id: `memory:${memoryDigest(memorySnapshotBody(input))}` }
}

/** Do not serialize admission/provenance control data into prompts or charge body budget for it. */
export function memorySnapshotBody<T extends Omit<MemorySnapshot, 'id'>>(snapshot: T) {
  const { admission: _admission, sourceEpochs: _epochs, legacyMemoryInvalidated: _legacy,
    legacyMemoryCells: _cells, legacyMemoryCellsComplete: _complete, ...body } = snapshot
  return body
}
/** Whole records only. Core is retained before directory entries, recall excerpts, and optional strategy hints. */
export function fitMemorySnapshot(source: MemorySnapshot, contextWindowTokens: number, availableTokens = Infinity): MemorySnapshot {
  const max = Math.max(0,Math.min(source.budget.maxTokens,Math.floor(contextWindowTokens*source.budget.ratio),availableTokens))
  const result = structuredClone(source)
  result.core=[]; result.directory=[]; result.recalled=[]; result.strategies=[]
  const base = Buffer.byteLength(JSON.stringify(memorySnapshotBody(result)))+128
  let remaining = Math.max(0,max-base)
  if (source.budget.allocation) {
    const capacity = remaining, allocation = source.budget.allocation
    const omissions = result.diagnostics?.omissions ?? []
    for (const field of ['core','recalled','directory','strategies'] as const) {
      let reserved = Math.floor(capacity*allocation[field])
      for (const item of source[field]) {
        let candidates: unknown[] = [item]
        if (field === 'core' && Buffer.byteLength(JSON.stringify(item))+1>reserved) {
          const doc = item as import('./types.js').MemoryDocument
          // Preserve complete storage and identify each bounded context fragment.
          // The model can read the original document using the retained id/version.
          candidates=[]
          let offset=0
          while (offset<doc.body.length) {
            const body=excerpt(doc.body.slice(offset),768),end=offset+body.length
            candidates.push({...doc,body,contextFragment:{offset,end,total:doc.body.length,version:doc.version}})
            offset=end
          }
          omissions.push({field,id:doc.id,reason:'fragmented'})
        }
        let omitted=false
        for (const candidate of candidates) {
          const bytes=Buffer.byteLength(JSON.stringify(candidate))+1
          if (bytes>reserved || bytes>remaining) { omitted=true; continue }
          reserved-=bytes;remaining-=bytes;(result[field] as unknown[]).push(candidate)
        }
        if (omitted) {
          result.omitted[field]++
          omissions.push({field,id:String((item as {id?:string}).id ?? field),reason:'allocation'})
        }
      }
    }
    result.diagnostics={...source.diagnostics,elapsedMs:source.diagnostics?.elapsedMs ?? 0,coreRead:source.core.length,recalled:source.recalled.length,
      injected:result.core.length+result.recalled.length,omissions:omissions.slice(0,32)}
    // Diagnostics consume the same bounded input allocation as their evidence.
    while(Buffer.byteLength(JSON.stringify(memorySnapshotBody(result)))>max && result.diagnostics.omissions.length) result.diagnostics.omissions.pop()
    const { id:_id,...value }=result
    return snapshotMemories(value)
  }
  for (const field of ['core','directory','recalled','strategies'] as const) {
    for (const item of source[field]) {
      const bytes = Buffer.byteLength(JSON.stringify(item))+1
      if (bytes>remaining) { result.omitted[field]++; continue }
      remaining-=bytes
      // The field and item are correlated by the loop; no body is partially copied.
      ;(result[field] as unknown[]).push(item)
    }
  }
  const { id: _id,...value } = result
  return snapshotMemories(value)
}

export function roundRobin<T>(groups: T[][]): T[] {
  const items: T[] = []
  for (let index=0;index<Math.max(0,...groups.map(group => group.length));index++) {
    for (const group of groups) if (index<group.length) items.push(group[index]!)
  }
  return items
}
