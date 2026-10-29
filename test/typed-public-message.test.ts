import assert from 'node:assert/strict'
import {it} from 'node:test'
import {OpenAIChatDriver,type OpenAIDriverOptions} from '../src/model/openai.js'
import type {ModelTurnResult} from '../src/model/driver.js'
const option={publicTextContinuation:'typed-message-v1'} as unknown as Partial<OpenAIDriverOptions>
const operation={kind:'append',supersedes:[]}
const body=(answer:string|null,outcome:unknown=null)=>JSON.stringify({operation,commentary:'',answer,outcome})
function driver(content:string,enabled=true,finish='stop'){
  let payload:Record<string,unknown>|undefined
  const model=new OpenAIChatDriver('typed-message-fixture',{apiKey:'synthetic',publicTextProtocol:'purpose-json-v3',maxAttempts:1,
    capabilities:{jsonObjectWithTools:false,parallelTools:false},...(enabled?option:{}),fetchImpl:async(_url,init)=>{
      payload=JSON.parse(String(init?.body)) as Record<string,unknown>
      return new Response(`data: ${JSON.stringify({choices:[{delta:{content},finish_reason:finish}]})}\n\ndata: [DONE]\n\n`)
    }})
  return {model,get payload(){return payload}}
}
const request={instructions:'Use only the supplied synthetic facts.',items:[],codeExecution:'disabled' as const}
it('explicit typed message ends its item without declaring a final outcome',async()=>{
  const f=driver(body(' Known facts. ')),seen:string[]=[]
  const result=await f.model.run({...request,onTextDelta:d=>{seen.push(d)}})
  assert.equal((result as ModelTurnResult & {publicTextPhase?:string}).publicTextPhase,'intermediate')
  assert.equal(result.outcomeDeclaration,undefined);assert.equal(result.text,' Known facts. ')
  assert.equal(seen.join(''),' Known facts. ');assert.deepEqual(result.answerOperation,operation)
})
it('old v3 binding still requires a terminal outcome with no tools',async()=>{
  await assert.rejects(driver(body('Known facts.'),false).model.run(request),e=>(e as {diagnostics?:{protocolCode?:string}}).diagnostics?.protocolCode==='terminal_outcome_required')
})
it('terminal arithmetic remains one normal result with original business schemas',async()=>{
  const f=driver(body('43',{status:'satisfied',gaps:[]}))
  const tools: import('../src/tools/catalog.js').ToolDefinition[]=[{name:'read__value',action:'read.value',description:'Read a synthetic value.',parameters:{type:'object' as const,properties:{value:{type:'integer'}},required:['value'],additionalProperties:false},effect:'read' as const,approval:false}]
  const result=await f.model.run({...request,tools})
  assert.equal((result as ModelTurnResult & {publicTextPhase?:string}).publicTextPhase,undefined)
  assert.equal(result.text,'43');assert.equal(result.outcomeDeclaration?.status,'satisfied')
  const system=(f.payload!['messages'] as Array<{content:string}>)[0]!.content
  assert.equal(f.model.protocolTokens,f.model.countTokens(system.slice(request.instructions.length+2)))
  assert.match(system,/Message lifecycle capability/);assert.doesNotMatch(system,/never in an extra introductory call/)
  assert.deepEqual((f.payload!['tools'] as Array<{function:{parameters:unknown}}>)[0]!.function.parameters,tools[0]!.parameters)
})
for(const [name,content,finish] of [['empty',body(''),'stop'],['whitespace',body('  '),'stop'],['null',body(null),'stop'],['prose','Known facts.','stop'],['truncated',body('Known facts.').slice(0,-1),'stop'],['bad finish',body('Known facts.'),'length']] as const){
  it(`never accepts ${name} as an intermediate item`,async()=>{
    await assert.rejects(driver(content,true,finish).model.run({...request,answerContext:{messageId:'answer',segmentIds:['already-sealed']}}))
  })
}
it('continuation configuration is explicit, versioned, clone-safe and incompatible with envelope transport',()=>{
  const f=driver(body('43',{status:'satisfied',gaps:[]})).model
  assert.equal((f as unknown as {publicTextContinuation?:string}).publicTextContinuation,'typed-message-v1')
  assert.equal((f.singleAttempt() as unknown as {publicTextContinuation?:string}).publicTextContinuation,'typed-message-v1')
  assert.equal((f.withPublicTextProtocol('purpose-json-v2') as unknown as {publicTextContinuation?:string}).publicTextContinuation,undefined)
  assert.notEqual(f.configurationFingerprint,driver(body('43'),false).model.configurationFingerprint)
  assert.equal(f.withPublicTextProtocol('purpose-json-v2').configurationFingerprint,new OpenAIChatDriver('typed-message-fixture',{apiKey:'synthetic',publicTextProtocol:'purpose-json-v2',maxAttempts:1,capabilities:{jsonObjectWithTools:false,parallelTools:false}}).configurationFingerprint)
  assert.throws(()=>new OpenAIChatDriver('invalid',{apiKey:'synthetic',publicTextProtocol:'purpose-json-v2',...option}),/continuation/)
  assert.throws(()=>new OpenAIChatDriver('invalid',{apiKey:'synthetic',publicTextProtocol:'purpose-json-v3',nativeToolPublicOutput:'envelope-v1',capabilities:{jsonObjectWithTools:false,parallelTools:false},...option}),/continuation/)
})

it('execution and quota wrappers retain capability and meter intermediate as one generation',async()=>{
  const {executionModel}=await import('../src/model/execution.js')
  const {limitModel}=await import('../src/model/quota.js')
  const {ResourceQuota}=await import('../src/resource-quota.js')
  const {DEFAULT_MODEL_BUDGET}=await import('../src/model/execution.js')
  let reservations=0,settlements=0
  const f=driver(body('Known fact.'))
  const wrapped=executionModel({reserveModelCall:async()=>{reservations++;return {allowed:true,deadlineAt:new Date(Date.now()+5000).toISOString(),remainingCalls:10,remainingTokens:100000,remainingCostMicros:1000000}},recordModelUsage:async()=>{settlements++}},
    limitModel(f.model,new ResourceQuota(1)),{id:'typed',fence:1,tenantId:'tenant',agentId:'agent',sessionId:'session'} as import('../src/protocol/types.js').WorkItem,DEFAULT_MODEL_BUDGET)
  assert.equal(wrapped.publicTextContinuation,'typed-message-v1')
  assert.equal((await wrapped.run(request)).publicTextPhase,'intermediate')
  assert.equal(reservations,1);assert.equal(settlements,1)
})
it('cancellation from operation callback never releases answer text or a completed intermediate result',async()=>{
  const f=driver(body('Known fact.')),stop=new AbortController(),seen:string[]=[]
  await assert.rejects(f.model.run({...request,signal:stop.signal,onTextOperation:()=>stop.abort(new Error('synthetic cancellation')),onTextDelta:d=>{seen.push(d)}}))
  assert.deepEqual(seen,[])
})
it('sealed message recovery retains memory provenance and a durable cursor through compaction',async()=>{
  const {AnswerSegmentSet}=await import('../src/runtime/answer-segments.js')
  const {projectMemoryHistory}=await import('../src/memory/history.js')
  const {createHash}=await import('node:crypto')
  const text='Previously authorized synthetic fact.'
  const identity={version:3 as const,purpose:'answer' as const,messageId:'answer:run:v1',requestVersion:1,fence:1,attemptId:'attempt',partId:'part',segmentId:'part',partIndex:1,operation:'append' as const,supersedes:[]}
  const recovery={version:1 as const,phase:'intermediate' as const,memorySources:{version:1 as const,sources:[{tenantId:'tenant',scopeType:'agent' as const,scopeId:'agent',epoch:1,forgottenAt:null}]}}
  const step={id:'seal',artifacts:[],kind:'runtime.answer_segment',requestVersion:1,input:{...identity,bodyHash:createHash('sha256').update(text).digest('hex')},output:JSON.stringify({text,recovery})} as import('../src/control-plane/steps.js').ExecutionStep
  const set=new AnswerSegmentSet('run',1,2,[step])
  const session={history:[],request:{workId:'work',revisions:[]}} as unknown as import('../src/protocol/types.js').SessionRecord
  assert.equal(set.restoreMessageHistory(session,'work'),true)
  assert.equal('role' in session.history[0]! ? session.history[0].content : undefined,text)
  assert.equal(JSON.stringify(projectMemoryHistory(session.history,undefined)).includes(text),false,'revoked memory is withheld from model input')
  assert.equal(set.restoreMessageHistory(session,'work'),false)
  session.history=[] // compaction has replaced old history; the request cursor persists
  const resumed=JSON.parse(JSON.stringify(session)) as typeof session
  assert.equal(new AnswerSegmentSet('run',1,3,[step]).restoreMessageHistory(resumed,'work'),false)
  assert.deepEqual(resumed.history,[])
  assert.throws(()=>set.restoreMessageHistory({...session,request:{...session.request!,workId:'other'}},'work'),/identity/)
})

it('in-memory event projection excludes host-only seal recovery metadata',async()=>{
  const {MemoryEventStore}=await import('./memory-store-fixture.js')
  const events=new MemoryEventStore()
  await events.append({runId:'run',seq:1,tenantId:'tenant',agentId:'agent',recordedAt:new Date().toISOString(),kind:'public.text.sealed',stage:'completed',visibility:'user',data:{},
    publicTextRecovery:{version:1,phase:'intermediate',memorySources:{version:1,sources:[],unknown:true}}})
  assert.equal((await events.listRange('run',0,1))[0]!.publicTextRecovery,undefined)
})

it('fallback cannot silently switch between terminal-only and typed-message capabilities',async()=>{
  const {executionModel,DEFAULT_MODEL_BUDGET}=await import('../src/model/execution.js')
  const host={reserveModelCall:async()=>{throw new Error('unused')},recordModelUsage:async()=>{}}
  const fallback={model:driver(body('Known fact.'),false).model,inputCostMicrosPerMillion:DEFAULT_MODEL_BUDGET.inputCostMicrosPerMillion,outputCostMicrosPerMillion:DEFAULT_MODEL_BUDGET.outputCostMicrosPerMillion,authorize:async()=>{}}
  assert.throws(()=>executionModel(host,driver(body('Known fact.')).model,{id:'work',fence:1} as import('../src/protocol/types.js').WorkItem,DEFAULT_MODEL_BUDGET,undefined,'model',fallback),/compatible/)
})
