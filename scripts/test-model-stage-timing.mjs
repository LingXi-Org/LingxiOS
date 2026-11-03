import assert from 'node:assert/strict'
import {test} from 'node:test'
import {OpenAIChatDriver} from '../dist/src/model/openai.js'
import {executionModel,DEFAULT_MODEL_BUDGET} from '../dist/src/model/execution.js'
import {ModelTimingCollector,readModelStageTimings} from '../dist/src/model/timing.js'
import {PublicTextAttemptWriter,PublicTextPublicationError} from '../dist/src/runtime/public-text.js'
import {limitModel} from '../dist/src/model/quota.js'
import {readPublicTextPublicationTiming} from '../dist/src/runtime/publication-timing.js'
import {ResourceQuota} from '../dist/src/resource-quota.js'
const work={id:'synthetic-work',fence:2,requestVersion:3,tenantId:'tenant',agentId:'agent',sessionId:'session'}
const host=observations=>({reserveModelCall:async()=>({allowed:true,deadlineAt:new Date(Date.now()+60000).toISOString(),remainingCalls:10,remainingTokens:100000,remainingCostMicros:1000000}),recordModelUsage:async(_work,_id,_usage,observation)=>{observations.push(observation)}})
const request={instructions:'synthetic',items:[],tools:[],codeExecution:'disabled'}
const args={operation:{kind:'append',supersedes:[]},answer:'safe',outcome:{status:'satisfied',gaps:[]}}
const frame=body=>'data: '+JSON.stringify({choices:[{delta:body,finish_reason:body.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:3,completion_tokens:2}})+'\n\ndata: [DONE]\n\n'
const call=(name='public_answer',value=args)=>({index:0,id:'synthetic-call',type:'function',function:{name,arguments:JSON.stringify(value)}})
const options={apiKey:'synthetic',maxAttempts:1,publicTextProtocol:'purpose-json-v3',publicTextContinuation:'typed-message-v1',publicAnswerTool:'native-v3',capabilities:{jsonObjectWithTools:false,parallelTools:true}}
test('controlled slow model/callback/both preserve nested timing without inventing provider inference',async t=>{
 for(const [modelDelay,callbackDelay] of [[50,0],[0,40],[50,40]]){
  let now=100
  t.mock.method(performance,'now',()=>now)
  const observations=[]
  const source=new OpenAIChatDriver('synthetic',{...options,fetchImpl:async()=>{
   now+=modelDelay
   return new Response(frame({tool_calls:[call()]}))
  }})
  const model=executionModel(host(observations),source,work,DEFAULT_MODEL_BUDGET)
  await model.run({...request,onTextOperation:()=>{},onTextDelta:()=>{now+=callbackDelay}})
  const timing=observations[0].stageTimings
  assert.equal(timing.httpToHeadersMs,modelDelay)
  assert.equal(timing.httpToFirstCompleteToolCallMs,modelDelay)
  assert.equal(timing.observedStreamMs,modelDelay+callbackDelay)
  assert.equal(timing.outputCallbackWaitMs,callbackDelay)
  assert.equal(timing.outputCallbackTotalMs,callbackDelay)
  assert.equal(timing.totalMs,modelDelay+callbackDelay)
  assert.equal(timing.httpToFirstContentMs,undefined,'tool-only wire cannot manufacture first content zero')
  assert.equal(timing.streamCompleted,true);assert.equal(timing.providerTime,'unavailable')
  assert.equal(observations[0].fence,2);assert.equal(observations[0].requestVersion,3)
  assert.equal(observations[0].usage.outputTokens,2)
  t.mock.restoreAll()
 }
})
test('overlapping callbacks distinguish sum from union, including rejection',async()=>{
 let now=0,releaseA,releaseB
 const timing=new ModelTimingCollector(()=>now)
 const first=timing.callback(()=>new Promise(resolve=>{releaseA=resolve}))
 now=10
 const second=timing.callback(()=>new Promise((_resolve,reject)=>{releaseB=reject}))
 now=20;releaseA();await first
 now=30;releaseB(new Error('private-marker'));await assert.rejects(second)
 assert.equal(timing.snapshot().outputCallbackTotalMs,40)
 assert.equal(timing.snapshot().outputCallbackWaitMs,30)
 assert.equal(timing.snapshot().outputCallbackCount,2)
})
test('protocol rejection then correction each retain real usage and their own timing',async()=>{
 const observations=[];let attempts=0
 const model=executionModel(host(observations),new OpenAIChatDriver('correction-timing',{...options,fetchImpl:async()=>new Response(++attempts===1?frame({content:'private-marker'}):frame({tool_calls:[call()]}))}),work,DEFAULT_MODEL_BUDGET)
 await assert.rejects(model.run(request))
 await model.run({...request,operation:'correction'})
 assert.equal(observations.length,2)
 assert.deepEqual(observations.map(o=>o.operation),['generation','correction'])
 assert.deepEqual(observations.map(o=>o.status),['failed','succeeded'])
 assert.ok(observations.every(o=>o.usage.outputTokens===2&&o.stageTimings.streamCompleted))
 assert.notEqual(observations[0].callId,observations[1].callId)
 assert.doesNotMatch(JSON.stringify(observations),/private-marker/)
})
test('public output confirms multiple flushes and a later seal using replacement snapshots',async t=>{
 let now=0; t.mock.method(performance,'now',()=>now)
 const snapshots=[],identity={version:1,requestVersion:3,fence:2,attemptId:'attempt',partId:'part',partIndex:0,messageId:'message'}
 const writer=new PublicTextAttemptWriter(identity,async()=>{now+=10},new AbortController().signal,undefined,'purpose-json-v3',async timing=>{snapshots.push(timing);now+=7})
 try{
  await writer.begin(args.operation);await writer.push('a'.repeat(5000),{purpose:'answer'})
  await writer.finish('a'.repeat(5000));await writer.end('completed');await writer.seal('a'.repeat(5000))
  assert.equal(snapshots.length,2)
  const last=snapshots.at(-1)
  assert.equal(last.publicationCount,5);assert.equal(last.acknowledgedCount,5)
  assert.equal(last.publicationTotalMs,50);assert.equal(last.publicationWaitMs,50)
  assert.equal(last.revision,2);assert.equal(last.callId,'attempt')
  assert.equal(snapshots[0].publicationTotalMs,40,'diagnostic persistence excludes its own overhead')
 }finally{writer.dispose();t.mock.restoreAll()}
})
test('failed publication reports safe stage/code and never claims an acknowledgement',async()=>{
 const snapshots=[],identity={version:1,requestVersion:1,fence:1,attemptId:'failed',partId:'failed',partIndex:0,messageId:'message'}
 const writer=new PublicTextAttemptWriter(identity,async event=>{if(event.kind==='public.text.delta')throw new Error('private-marker')},new AbortController().signal,undefined,'purpose-json-v3',async value=>{snapshots.push(value)})
 try{
  await writer.begin(args.operation)
  await assert.rejects(writer.push('private-marker',{purpose:'answer'}),PublicTextPublicationError)
  await assert.rejects(writer.end('failed'),PublicTextPublicationError)
  assert.deepEqual(snapshots[0].failure,{stage:'delta',code:'persistence_rejected'})
  assert.equal(snapshots[0].publicationCount,2);assert.equal(snapshots[0].acknowledgedCount,1)
  assert.doesNotMatch(JSON.stringify(snapshots),/private-marker/)
 }finally{writer.dispose()}
})
test('permit waits and cancelled queued calls retain timing without invoking provider',async()=>{
 const quota=new ResourceQuota(1),observations=[]
 let release
 const holding=quota.run(()=>new Promise(resolve=>{release=resolve}))
 let providerCalls=0
 const model=executionModel(host(observations),limitModel(new OpenAIChatDriver('cancel-queue',{...options,fetchImpl:async()=>{providerCalls++;return new Response(frame({tool_calls:[call()]}))}}),quota),work,DEFAULT_MODEL_BUDGET)
 const stop=new AbortController()
 const pending=model.run({...request,signal:stop.signal})
 await new Promise(resolve=>setImmediate(resolve));stop.abort(new Error('cancel'))
 await assert.rejects(pending)
 assert.equal(providerCalls,0);assert.equal(observations[0].usage.outputTokens,0)
 assert.ok(observations[0].stageTimings.modelPermitWaitMs>=0)
 assert.equal(observations[0].status,'failed')
 release();await holding
 await model.run(request)
 assert.ok(observations[1].stageTimings.modelPermitWaitMs>=0)
})
test('safe timing projection rejects unknown versions, bad numbers and hostile getters',()=>{
 assert.equal(readModelStageTimings({version:2}),undefined)
 const safe=readModelStageTimings({version:1,clock:'monotonic',providerTime:'unavailable',httpToHeadersMs:-1,totalMs:0,prompt:'private-marker',outputCallbackCount:1.5})
 assert.deepEqual(safe,{version:1,clock:'monotonic',providerTime:'unavailable',totalMs:0})
 assert.equal(readModelStageTimings({get version(){throw new Error('private-marker')}}),undefined)
})

test('a timed-out body and cancellation preserve known HTTP phases on failed ledger observations',async()=>{
 for(const cancelled of [false,true]){
  const observations=[],stop=new AbortController()
  let entered
  const ready=new Promise(resolve=>{entered=resolve})
  const model=executionModel(host(observations),new OpenAIChatDriver('stalled-stream-'+cancelled,{...options,recovery:{maxAttempts:1},requestTimeoutMs:30,firstByteTimeoutMs:30,
   fetchImpl:async()=>{entered();return new Response(new ReadableStream({pull:()=>new Promise(()=>{})}))}}),work,DEFAULT_MODEL_BUDGET)
  const rejected=assert.rejects(model.run({...request,signal:stop.signal}))
  await ready;await new Promise(resolve=>setImmediate(resolve))
  const keepAlive=setTimeout(()=>{},1000)
  try{
   if(cancelled)stop.abort(new Error('synthetic cancellation'))
   await rejected
   const timing=observations[0].stageTimings
   assert.equal(observations[0].status,'failed');assert.equal(timing.httpRequestCount,1)
   assert.ok(timing.httpToHeadersMs>=0);assert.ok(timing.observedStreamMs>=0)
   assert.equal(timing.streamCompleted,false);assert.equal(timing.httpToFirstContentMs,undefined)
  }finally{clearTimeout(keepAlive)}
 }
})

test('publication diagnostic projection is closed and rejects invalid counters and unsafe failures',()=>{
 const value={version:1,clock:'monotonic',callId:'synthetic',fence:1,requestVersion:1,revision:1,publicationCount:2,acknowledgedCount:1,publicationTotalMs:0,publicationWaitMs:0}
 assert.deepEqual(readPublicTextPublicationTiming({...value,prompt:'private-marker'}),value)
 for(const invalid of [{...value,acknowledgedCount:3},{...value,revision:0},{...value,publicationWaitMs:NaN},{...value,failure:{stage:'private-marker',code:'persistence_rejected'}}])assert.equal(readPublicTextPublicationTiming(invalid),undefined)
 assert.equal(readPublicTextPublicationTiming({get version(){throw Error('private-marker')}}),undefined)
})
