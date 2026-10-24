import { memoryDependencies, type MemorySources } from '../memory/history.js'
import { decodePublicAnswerCall, type PublicAnswerCall } from './public-answer-call.js'

/** Host-only metadata. Persist with the seal, never in public event data. */
export type PublicTextRecovery = {
  version: 1
  phase: 'intermediate'
  memorySources: MemorySources
} | {
  version: 2
  phase: 'intermediate' | 'terminal'
  memorySources: MemorySources
  publicAnswerCall: PublicAnswerCall
  explanationStageId?: string
}
export function snapshotPublicTextRecovery(value: PublicTextRecovery): PublicTextRecovery {
  if(value?.version===2){
    if(!['intermediate','terminal'].includes(value.phase)||!value.memorySources
      || Object.keys(value).some(key=>!['version','phase','memorySources','publicAnswerCall','explanationStageId'].includes(key)))throw new Error('invalid public text recovery metadata')
    if(value.explanationStageId!==undefined&&(!/^[a-f0-9]{64}$/.test(value.explanationStageId)||value.phase!=='intermediate'))throw new Error('invalid explanation stage binding')
    const decoded=decodePublicAnswerCall(value.publicAnswerCall)
    if((decoded.outcome===null)!==(value.phase==='intermediate')||decoded.text===null)throw new Error('invalid sealed output call phase')
    return {version:2,phase:value.phase,publicAnswerCall:{...value.publicAnswerCall},
      ...(value.explanationStageId?{explanationStageId:value.explanationStageId}:{}),
      memorySources:memoryDependencies([{role:'assistant',content:'',memorySources:value.memorySources}])}
  }
  if(!value || value.version!==1 || value.phase!=='intermediate' || !value.memorySources
    || Object.keys(value).some(key=>!['version','phase','memorySources'].includes(key)))throw new Error('invalid public text recovery metadata')
  return {version:1,phase:'intermediate',memorySources:memoryDependencies([{role:'assistant',content:'',memorySources:value.memorySources}])}
}
