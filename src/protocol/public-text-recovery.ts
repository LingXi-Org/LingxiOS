import { memoryDependencies, type MemorySources } from '../memory/history.js'

/** Host-only metadata. Persist with the seal, never in public event data. */
export interface PublicTextRecovery {
  version: 1
  phase: 'intermediate'
  memorySources: MemorySources
}
export function snapshotPublicTextRecovery(value: PublicTextRecovery): PublicTextRecovery {
  if(!value || value.version!==1 || value.phase!=='intermediate' || !value.memorySources
    || Object.keys(value).some(key=>!['version','phase','memorySources'].includes(key)))throw new Error('invalid public text recovery metadata')
  return {version:1,phase:'intermediate',memorySources:memoryDependencies([{role:'assistant',content:'',memorySources:value.memorySources}])}
}
