import assert from 'node:assert/strict'
import { it } from 'node:test'
import { OpenAIChatDriver, type OpenAIDriverOptions } from '../src/model/openai.js'
import { ModelDriverError } from '../src/errors.js'
import { modelProtocolCorrection } from '../src/runtime/protocol-correction.js'

const frame=(content:string|null,finish:string|null=null,tool=false)=>`data: ${JSON.stringify({choices:[{delta:{content,reasoning_content:'PRIVATE_SENTINEL',...(tool?{tool_calls:[{index:0,id:'read-one',type:'function',function:{name:'probe',arguments:'{}'}}]}:{})},finish_reason:finish}]})}\n\n`
const usage='data: '+JSON.stringify({choices:[],usage:{prompt_tokens:100,completion_tokens:20}})+'\n\ndata: [DONE]\n\n'
const tool={name:'probe',action:'probe.read',description:'Read a record',parameters:{type:'object' as const,properties:{},additionalProperties:false as const},effect:'read' as const,approval:false}
const options=(fetchImpl:OpenAIDriverOptions['fetchImpl'],protocol='purpose-json-v2')=>({apiKey:'synthetic',maxAttempts:1,publicTextProtocol:protocol,fetchImpl} as OpenAIDriverOptions)
const driver=(wire:string,toolCall=false)=>new OpenAIChatDriver('outcome-fixture',options(async()=>new Response(frame(wire,toolCall?'tool_calls':'stop',toolCall)+usage)))
const request={instructions:'Answer the current request',items:[],codeExecution:'disabled' as const}
const wire=(status:string,gaps:string[],answer='Result')=>JSON.stringify({commentary:'',answer,outcome:{status,gaps}})

it('streams the answer before bounded outcome metadata and returns a typed declaration without a judge',async()=>{
  let release!:()=>void,seenAnswer!:()=>void,finished=false
  const gate=new Promise<void>(resolve=>{release=resolve}),first=new Promise<void>(resolve=>{seenAnswer=resolve})
  const parts:string[]=[],purposes:unknown[]=[]
  let requests=0
  const model=new OpenAIChatDriver('outcome-stream',options(async(_url,init)=>{
    requests++;const sent=JSON.parse(String(init?.body));assert.match(JSON.stringify(sent.messages),/purpose-json-v2/)
    assert.deepEqual(sent.response_format,{type:'json_object'})
    return new Response(frame('{"commentary":"","answer":"A')+frame('\\uD83D\\uDE00\\nB","outcome":{"status":"partial","gaps":["Missing a source"]}}','stop')+usage)
  }))
  const running=model.run({...request,onTextDelta:async(text,metadata)=>{parts.push(text);purposes.push(metadata);if(text==='A'){seenAnswer();await gate}}}).then(result=>{finished=true;return result})
  try{await Promise.race([first,running.then(()=>{})]);assert.equal(finished,false)}finally{release()}
  const result=await running
  assert.equal(result.text,'A😀\nB');assert.deepEqual(Reflect.get(result,'outcomeDeclaration'),{status:'partial',gaps:['Missing a source']})
  assert.equal(parts.join(''),'A😀\nB');assert.ok(purposes.every(value=>(value as {purpose:string}).purpose==='answer'))
  assert.doesNotMatch(parts.join(''),/outcome|status|Missing a source|PRIVATE_SENTINEL/);assert.equal(requests,1)
})

it('validates declaration shape and limits without classifying quoted, conditional, Unicode or negative prose',async()=>{
  for(const answer of ['“未发送”是一个例子；实际问题待澄清。','If access is granted, the update can run.','The statement “not possible” is not the requested result.','缺少输入😀\n请补充。']){
    const result=await driver(wire('blocked',['The required input is missing.'],answer)).run(request)
    assert.equal(result.text,answer);assert.equal(result.outcomeDeclaration?.status,'blocked')
  }
  const invalid=[
    '{"commentary":"","answer":"Result"}',
    '{"commentary":"","answer":"Result","outcome":null}',
    wire('satisfied',['Unfinished']),wire('partial',[]),wire('blocked',['']),wire('unknown',[]),
    wire('partial',Array.from({length:17},()=> 'gap')),wire('partial',['x'.repeat(1001)]),
    wire('partial',Array.from({length:16},()=> 'x'.repeat(1000))),
    '{"commentary":"","answer":"Result","outcome":{"status":"partial","status":"satisfied","gaps":[]}}',
    '{"commentary":"","answer":"Result","outcome":{"status":"partial","gaps":["gap"],"extra":true}}',
    '{"commentary":"","answer":"Result","outcome":{"status":"partial","gaps":["gap"]}',
    '{"commentary":"","answer":"Result","outcome":{"status":"satisfied","gaps":[]},"answer":"again"}',
    wire('satisfied',[])+' trailing',
  ]
  for(const value of invalid)await assert.rejects(driver(value).run(request),error=>error instanceof ModelDriverError&&error.diagnostics.kind==='protocol')
})

it('rejects the retired v1 configuration',()=>{
  assert.throws(()=>new OpenAIChatDriver('identity',options(async()=>new Response(), 'purpose-json-v1')),/invalid public text protocol/)
})

it('permits tool-only output and null intermediate declaration without terminal metadata',async()=>{
  const empty=new OpenAIChatDriver('native-only',options(async()=>new Response(frame(null,'tool_calls',true)+usage)))
  const emptyResult=await empty.run({...request,tools:[tool]});assert.equal(emptyResult.text,'');assert.equal(Reflect.get(emptyResult,'outcomeDeclaration'),undefined)
  assert.equal(emptyResult.output.length,1)
  const progress=await driver(JSON.stringify({commentary:'Reading',answer:'Known prefix',outcome:null}),true).run({...request,tools:[tool]})
  assert.equal(progress.text,'Known prefix');assert.equal(Reflect.get(progress,'outcomeDeclaration'),undefined)
  await assert.rejects(driver(wire('satisfied',[]),true).run({...request,tools:[tool]}),/public text protocol/)
})

it('preserves cancellation between answer and metadata and usage on declaration rejection',async()=>{
  const controller=new AbortController()
  await assert.rejects(driver(wire('satisfied',[])).run({...request,signal:controller.signal,onTextDelta:()=>controller.abort()}),error=>error instanceof Error&&error.name==='AbortError')
  try{await driver(wire('partial',[])).run(request);assert.fail('invalid declaration accepted')}catch(error){
    assert.ok(error instanceof ModelDriverError);assert.equal(error.diagnostics.usage?.inputTokens,100);assert.equal(error.diagnostics.usage?.outputTokens,20)
  }
})

it('v2 protocol repair names the pinned wire and never replays completed or uncertain effects',()=>{
  const correction=(modelProtocolCorrection as (...args:unknown[])=>{content:string})({finishReasons:[],kind:'protocol',protocolCode:'public_text_invalid'},'disabled','purpose-json-v2')
  assert.match(correction.content,/purpose-json-v2/);assert.doesNotMatch(correction.content,/purpose-json-v1/)
  assert.match(correction.content,/Existing receipts remain the record of completed or uncertain actions\./)
})
