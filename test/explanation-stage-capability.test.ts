import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS, skillIndex } from '../src/index.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import { actionKeyOf, sessionKeyOf, type WorkItem } from '../src/protocol/types.js'
import { snapshotRequest } from '../src/context/request.js'
import { OpenAIChatDriver } from '../src/model/openai.js'
import { PROMPT_CONTRACT_VERSION } from '../src/prompts/provider.js'
import { releaseVersions } from '../src/versions.js'

const text='Explain these facts. Make a diagram. Gather collects items.'
const explanation={explanationQuote:'Explain these facts.',authoringQuote:'Make a diagram.',factQuotes:['Gather collects items.']}
const skill={name:'diagram',version:'1',description:'Create a diagram.',body:'Use the requested facts.',actions:['documents.save'],delivery:{checker:'product:diagram'},workflow:{explanationBeforeAuthoring:{authoringActions:['documents.save']}}}
const {name,version,hash}=skillIndex(skill), selection={name,version,hash}
const driver = (native:boolean,privateV2=false) => new OpenAIChatDriver('synthetic-stage-capability',{apiKey:'synthetic-only',maxAttempts:1,publicTextProtocol:privateV2?'purpose-json-v2':'purpose-json-v3',...(!privateV2?{publicTextContinuation:'typed-message-v1' as const}:{}),...(native&&!privateV2?{publicAnswerTool:'native-v1' as const}:{}),capabilities:{parallelTools:false,jsonObjectWithTools:false},fetchImpl:async()=>{throw new Error('this action-only fixture must not invoke a provider')}})
function bindingFor(mode:'main'|'fast'|'private') {
 const model=driver(mode!=='main',mode==='private'),fast=mode==='fast'?driver(false,true):undefined
 return {runtime:releaseVersions.runtime,semanticReview:'selective',harness:null,prompt:PROMPT_CONTRACT_VERSION,model:model.modelId,provider:model.configurationFingerprint,
   publicTextProtocol:model.publicTextProtocol,...(model.publicTextContinuation?{publicTextContinuation:model.publicTextContinuation}:{}),...(model.publicAnswerTool?{publicAnswerTool:model.publicAnswerTool}:{}),
   ...(fast?{fastProvider:fast.configurationFingerprint,fastPublicTextProtocol:fast.publicTextProtocol}:{})}
}
const action=(work:WorkItem,cellId:string,args:Record<string,unknown>)=>{const key={runId:work.id,cellId,callIndex:0};return {...key,idempotencyKey:actionKeyOf(key),action:'skills.activate',args}}
async function fixture(){
  const db=new PGlite(); await db.exec(await readFile(new URL('../../db/schema.sql',import.meta.url),'utf8'))
  const query:SqlPool['query']=async(sql,values)=>{const result=await db.query<Record<string,unknown>>(sql,values);return {rows:result.rows,rowCount:result.affectedRows??result.rows.length}}
  const pool:SqlPool={query,connect:async()=>({query,release(){}})};let effects=0
  const app=await createLingxiOS({database:pool,background:{role:'passive'},performance:{notifications:false},skills:[skill],capabilityResolver:{resolve:async()=>[{name:'documents'}]},
    tools:[{name:'documents__save',action:'documents.save',effect:'idempotent',approval:false,description:'Save a synthetic diagram.',parameters:{type:'object',properties:{},additionalProperties:false},parse:()=>({}),authorize:async()=>{},execute:async()=>{effects++;return {ok:true,value:{}}}}]})
  const host=app.connectWorker({workerId:'stage-capability-test',workKinds:['turn']})
  const session=async(work:WorkItem)=>host.saveSession(work,{key:sessionKeyOf(work),tenantId:work.tenantId,agentId:work.agentId,sessionId:work.sessionId,history:[],appliedWorkIds:[work.id],revision:0,compactionEpoch:0,request:snapshotRequest(await host.loadContext(work))})
  async function start(privateChild=false){
    if(!privateChild){await app.enqueue({id:'public-work',tenantId:'t',principalId:'human',agentId:'lead',sessionId:'public-room',text,mode:'execute'});const work=(await host.claimWork())!;await session(work);return work}
    await app.conversations.sync({tenantId:'t',conversationId:'room',version:1,kind:'group',owner:{kind:'participant',id:'human'},defaultAgentId:'lead',participants:[
      {id:'human',kind:'human',capabilities:['read','execute']},{id:'lead',kind:'agent',capabilities:['read','execute','speak']},{id:'helper',kind:'agent',capabilities:['read','execute','speak']}]})
    const parentIdentity=(await app.conversations.ingest({tenantId:'t',conversationId:'room',policyVersion:1,messageId:'parent-message',version:1,author:{kind:'human',id:'human'},text})).runs[0]!
    const parent=(await host.claimWork())!;await session(parent)
    await host.reserveModelCall(parent,'synthetic-parent-budget',{maxModelCalls:128,maxTokens:1_000_000,maxCostMicros:10_000_000,deadlineAt:new Date(Date.now()+1_800_000).toISOString(),reservedTokens:120,reservedInputTokens:100,reservedOutputTokens:20,childAdmission:{inputTokens:100,outputTokens:20,executionMs:1000}})
    await host.recordModelUsage(parent,'synthetic-parent-budget',{inputTokens:100,outputTokens:20,costMicros:0})
    const graph=await app.graphs.enqueue(parentIdentity,{id:'stage-capability-private',nodes:[{id:'child',agentId:'helper',text}]})
    const wait=await app.graphs.waitForChildren(parentIdentity,[graph.nodes[0]!.workId]);await host.waitWork(parent,{status:'delegated',taskRef:String(wait.data!['taskRef']),requestVersion:1,verification:'not_run'})
    const child=(await host.claimWork())!;assert.equal(child.id,graph.nodes[0]!.workId);assert.equal(child.conversation?.internal,true);await session(child);return child
  }
  return {app,pool,host,start,get effects(){return effects},async close(){await app.stop();await db.close()}}
}

for(const [label,binding,privateChild] of [
  ['missing binding',undefined,false],
  ['unsupported main driver',bindingFor('main'),false],
  ['unsupported fast route',bindingFor('fast'),false],
  ['native private child',bindingFor('private'),true],
] as const)it(`rejects an explanation declaration with ${label} before recording an activation`,async()=>{
  const f=await fixture()
  try{
    const work=await f.start(privateChild)
    // Complete bindings use the actual configured driver's protocol and
    // fingerprint. The unchanged control-plane validator persists them;
    // this action-only fixture performs no model generation.
    if(binding)await f.host.saveStep(work,{id:'runtime:binding',kind:'runtime.binding',requestVersion:1,input:binding,output:'{}',artifacts:[]})
    const result=await f.host.executeAction(work,action(work,'declare',{...selection,explanation}))
    assert.equal(result.ok,false,JSON.stringify(result));assert.equal(f.effects,0)
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM lingxios.agent_skill_activations WHERE work_id=$1',[work.id])).rows[0]!['n'],0)
    if(!privateChild){const normal=await f.host.executeAction(work,action(work,'normal',selection));assert.equal(normal.ok,true,JSON.stringify(normal))}
  }finally{await f.close()}
})
