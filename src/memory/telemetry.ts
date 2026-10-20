/** Diagnostic references only. Authorized reads resolve current text separately. */
export function memoryEventValue(value:unknown):unknown {
  if(!value || typeof value!=='object') return null
  const row=value as Record<string,unknown>
  if(typeof row['id']==='string' && Number.isSafeInteger(row['version'])) return {
    id:row['id'],version:row['version'],status:row['status'],title:'Memory',description:'Memory',
  }
  const out:Record<string,unknown>={}
  for(const field of ['document','snapshot']) if(row[field]) out[field]=memoryEventValue(row[field])
  for(const field of ['documents','items']) if(Array.isArray(row[field])) out[field]=(row[field] as unknown[]).slice(0,100).map(memoryEventValue)
  if(typeof row['retrieval']==='string') out['retrieval']=row['retrieval']
  if(Array.isArray(row['jobIds'])) out['jobIds']=(row['jobIds'] as unknown[]).filter(id=>typeof id==='string').slice(0,32)
  return out
}
