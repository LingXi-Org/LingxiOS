import assert from 'node:assert/strict'
import {setup,countsOnly} from './probe-cli.mjs'
await countsOnly(async()=>{
const cli=await setup()
const {projectMemoryHistory,SUMMARY_PREFIX}=await cli.importModule('dist/src/memory/history.js')
const marker='SYNTHETIC_COMPATIBILITY',count=value=>(JSON.stringify(value)??'').split(marker).length-1
const legacy={role:'user',content:SUMMARY_PREFIX+marker}
const ordinary=[{role:'user',content:'Current authorized original '+marker},{role:'assistant',content:'Already public answer '+marker}]
const clean={role:'user',content:SUMMARY_PREFIX+marker,memorySources:{version:1,sources:[]}}
const items=[legacy,...ordinary,clean],original=structuredClone(items)
const results=[]
for(const [name,snapshot] of [['available-empty-scopes',{status:'available',sourceEpochs:[]}],['unavailable',{status:'unavailable'}],['no-memory',undefined]]){
 const projected=projectMemoryHistory(items,snapshot)
 assert.equal(count(projected[0]),snapshot===undefined?1:0)
 assert.deepEqual(projected.slice(1),items.slice(1))
 assert.deepEqual(items,original)
 results.push({case:name,legacyModelSentinelCount:count(projected[0]),authorizedUserSentinelCount:count(projected[1]),publicAnswerSentinelCount:count(projected[2]),explicitCleanSummarySentinelCount:count(projected[3]),originalUnchanged:true})
}
await cli.writeJson('compatibility-counts.json',{head:cli.revision,cases:results})
console.log(JSON.stringify({cases:results.length,passed:true}))
})
