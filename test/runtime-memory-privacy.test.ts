import assert from 'node:assert/strict'
import {it} from 'node:test'
import {AgentRuntime,type AgentRuntimeOptions} from '../src/runtime/runtime.js'
import type {HostPort} from '../src/host/port.js'
import type {ModelDriver} from '../src/model/driver.js'
import type {RunEvent,TurnContext,WorkCompletion} from '../src/protocol/types.js'
import {durableProtocol} from './protocol-fixture.js'

// Events, payload trace, extension errors and continuation history are separate
// boundaries: only the authorized model/business receipt may retain this marker.
for(const mode of ['default','off-sample','legacy-trace','identity-redactor','throwing-redactor']) it(`keeps memory out of diagnostic events (${mode})`,async()=>{
  const secret='SYNTHETIC_MEMORY_SENTINEL_216'
  const work:TurnContext['work']={id:'privacy',tenantId:'t',agentId:'a',principalId:'u',sessionId:'s',kind:'turn',lane:'interactive',triggerRef:'m',fence:1,homeEpoch:1,leaseToken:'token'}
  const doc={id:'memory-id',tenantId:'t',scopeType:'user',scopeId:'u',path:'p.md',title:secret,description:secret,body:secret,
    layer:'core' as const,kind:'preference',origin:'explicit' as const,locked:true,version:1,status:'active' as const,sources:[],validUntil:null,updatedAt:'2026-10-20T00:00:00Z'}
  const events:RunEvent[]=[];let calls=0,modelSaw=false,completion:WorkCompletion|undefined
  const host:HostPort={...durableProtocol(),claimWork:async()=>null,heartbeat:async()=>({ok:true}),
    loadContext:async()=>({work,persona:{name:'A',role:'',instructions:''},capabilities:['memory'],
      tools:[{name:'memory__read',action:'memory.read',description:'Read',effect:'read',approval:false,parameters:{type:'object',properties:{},additionalProperties:false}}],
      memory:{id:'snapshot',status:'available',core:[doc],directory:[],recalled:[],strategies:[],omitted:{core:0,directory:0,recalled:0,strategies:0},budget:{ratio:.08,maxTokens:8000},retrieval:['keyword']},
      messages:[{ref:'m',authorId:'u',authorName:'U',authorKind:'human',body:'Use my memory.',createdAt:'now'}]}),
    executeAction:async(_work,action)=>action.action==='memory.read'?{ok:true,value:{document:doc,body:secret,sources:[]}}:{ok:true,value:{requestVersion:1,pending:[]}},
    emitEvent:async(_work,event)=>{events.push(event)},loadSession:async()=>null,saveSession:async()=>{},
    commitResult:async()=>{},completeWork:async(_work,value)=>{completion=value},yieldWork:async()=>{}}
  const model:ModelDriver={compact:async()=>{throw new Error('unexpected')},structured:async()=>{throw new Error('unexpected')},
    run:async request=>{
      if(++calls===1) return {text:'',output:[{type:'function_call',callId:'read',name:'memory__read',arguments:'{}'}],usage:{available:true,inputTokens:100,outputTokens:10}}
      modelSaw=JSON.stringify(request.items).includes(secret)
      throw new Error(secret)
    }}
  const options:AgentRuntimeOptions=mode==='legacy-trace'?{recordModelPayloads:true}:mode==='default'?{}:
    {modelTrace:{recordPayloads:true,sampleRate:mode==='off-sample'?0:1,redact:mode==='throwing-redactor'?()=>{throw new Error(secret)}:value=>value}}
  await new AgentRuntime(host,model,{execute:async()=>{throw new Error('unexpected')}},options).runWork(work)
  assert.equal(modelSaw,true,JSON.stringify({calls,status:completion?.status,error:completion?.error?.includes(secret)?'sentinel':completion?.error}))
  assert.equal(completion?.status,'failed')
  assert.equal(JSON.stringify({events,completion}).includes(secret),false,'diagnostics do not retain memory or extension error text')
  assert.ok(events.some(event=>event.kind==='tool.completed'))
})
