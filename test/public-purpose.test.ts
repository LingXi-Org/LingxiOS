import assert from 'node:assert/strict'
import { it } from 'node:test'
import { OpenAIChatDriver, type OpenAIDriverOptions } from '../src/model/openai.js'
import { inputTokens } from '../src/model/profile.js'
import { consumeRunEvent, createRunView } from '../src/ui/index.js'

const frame=(content:string,finish:string|null=null)=>`data: ${JSON.stringify({choices:[{delta:{content,reasoning_content:'PRIVATE_REASONING_SENTINEL'},finish_reason:finish}]})}\n\n`
const driver=(chunks:string[],onRequest?:(request:Record<string,unknown>)=>void)=>new OpenAIChatDriver('purpose-fixture',{
  apiKey:'fixture',maxAttempts:1,publicTextProtocol:'purpose-json-v1',fetchImpl:async(_url,init)=>{
    onRequest?.(JSON.parse(String(init?.body)));return new Response(chunks.map((chunk,index)=>frame(chunk,index===chunks.length-1?'stop':null)).join('')+'data: [DONE]\n\n')
  },
} as OpenAIDriverOptions)

it('declares purpose before the first character and streams split escaped answer before EOF',async()=>{
  const seen:Array<{text:string;meta:unknown}>=[]
  let release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve})
  let received!:()=>void
  const firstAnswer=new Promise<void>(resolve=>{received=resolve})
  const model=driver(['{"commentary":"Checking. e.g. explain nothing private","answer":"A','\\uD83D','\\uDE00\\nB"}'],request=>{
    assert.deepEqual(request['response_format'],{type:'json_object'})
    assert.match(JSON.stringify(request['messages']),/commentary/)
  })
  let complete=false
  const running=model.run({instructions:'Answer the user',items:[],codeExecution:'disabled',onTextDelta:async(text,...metadata:unknown[])=>{
    seen.push({text,meta:metadata[0]})
    if(text==='A'){received();await gate}
  }}).then(result=>{complete=true;return result})
  try { await Promise.race([firstAnswer,running.then(()=>{})]);assert.equal(complete,false);assert.deepEqual(seen.map(item=>item.meta),[{purpose:'commentary'},{purpose:'answer'}]) }
  finally{release()}
  const result=await running
  assert.equal(result.text,'A😀\nB')
  assert.deepEqual(result.output,[{role:'assistant',content:'A😀\nB'}])
  assert.equal(seen.filter(item=>(item.meta as {purpose:string})?.purpose==='answer').map(item=>item.text).join(''),'A😀\nB')
  assert.doesNotMatch(JSON.stringify(seen),/PRIVATE_REASONING_SENTINEL/)
})

it('fails closed on unframed, duplicate, reordered, incomplete and oversized framing without raw fallback',async()=>{
  for(const input of ['ordinary process before an answer','{"answer":"answer","commentary":"late"}',
    '{"commentary":"ok","answer":"answer","answer":"again"}', '{"commentary":"ok","answer":"unfinished',
    ' '.repeat(4097)+'{"commentary":"","answer":"answer"}', '{"commentary":"","answer":"\\uD800"}',
    '{"commentary":"","answer":"answer"} trailing']){
    const seen:string[]=[]
    await assert.rejects(driver([input]).run({instructions:'fixture',items:[],codeExecution:'disabled',onTextDelta:text=>{seen.push(text)}}),/public text protocol/)
    assert.ok(!seen.includes(input),'raw framing must never be published')
  }
})

it('keeps a plain legacy driver unchanged and separates configuration identity',async()=>{
  const legacy=new OpenAIChatDriver('purpose-fixture',{apiKey:'fixture',maxAttempts:1,fetchImpl:async()=>new Response(frame('normal answer','stop'))})
  const seen:unknown[]=[]
  assert.equal((await legacy.run({instructions:'fixture',items:[],codeExecution:'disabled',onTextDelta:(text,...meta:unknown[])=>{seen.push([text,meta[0]])}})).text,'normal answer')
  assert.deepEqual(seen,[['normal answer',undefined]])
  assert.notEqual(legacy.configurationFingerprint,driver([]).configurationFingerprint)
})

it('replay retains immutable v2 purpose and never accepts commentary as final source',()=>{
  const identity={version:2,requestVersion:1,fence:1,attemptId:'call',partId:'commentary',partIndex:0,purpose:'commentary'}
  const event={runId:'run',seq:1,kind:'public.text.delta',stage:'delta' as const,visibility:'user' as const,data:{...identity,chunkIndex:0,text:'public progress'}}
  let view=consumeRunEvent(createRunView('run'),event)
  assert.equal(Reflect.get(view.publicTextParts![0]!,'purpose'),'commentary')
  assert.throws(()=>consumeRunEvent(view,{...event,seq:2,data:{...event.data,purpose:'answer',chunkIndex:1}}),/identity/)
  view=consumeRunEvent(view,{...event,seq:2,kind:'response.committed',stage:'completed',data:{resultId:'forged',publicTextPartId:'commentary',requestVersion:1}})
  assert.equal(view.publicTextParts![0]!.acceptedResultId,null)
})

it('cancellation during commentary suppresses the answer in the same provider frame',async()=>{
  const stop=new AbortController(),seen:string[]=[]
  await assert.rejects(driver(['{"commentary":"Checking","answer":"MUST_NOT_PUBLISH"}']).run({instructions:'fixture',items:[],signal:stop.signal,
    onTextDelta:text=>{seen.push(text);stop.abort(new Error('cancelled fixture'))}}))
  assert.deepEqual(seen,['Checking'])
})

it('EOF protocol rejection retains observed usage and encoding instructions count toward admission',async()=>{
  const typed=new OpenAIChatDriver('purpose-usage-fixture',{apiKey:'fixture',maxAttempts:1,publicTextProtocol:'purpose-json-v1',
    fetchImpl:async()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:'{"commentary":"ok","answer":"'},finish_reason:'stop'}],usage:{prompt_tokens:17,completion_tokens:9}})+'\n\ndata: [DONE]\n\n') } as OpenAIDriverOptions)
  await assert.rejects(typed.run({instructions:'fixture',items:[]}),error=>{
    assert.deepEqual(Reflect.get(error as object,'diagnostics').usage,{available:true,inputTokens:17,outputTokens:9});return true
  })
  const legacy=new OpenAIChatDriver('purpose-usage-fixture',{apiKey:'fixture'})
  assert.ok(inputTokens(typed,{instructions:'same input'},true)>inputTokens(legacy,{instructions:'same input'}))
})

it('native tool calls may have commentary but cannot execute a simultaneous answer',async()=>{
  for(const answer of ['', 'premature answer']){
    const model=new OpenAIChatDriver('purpose-tool-fixture',{apiKey:'fixture',maxAttempts:1,publicTextProtocol:'purpose-json-v1',fetchImpl:async()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify({commentary:'Checking',answer}),tool_calls:[{index:0,id:'call',function:{name:'probe',arguments:'{}'}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n')} as OpenAIDriverOptions)
    const task=model.run({instructions:'fixture',items:[],codeExecution:'disabled',tools:[{name:'probe',action:'probe',effect:'read',approval:false,description:'fixture',parameters:{type:'object',properties:{},additionalProperties:false}}]})
    if(answer)await assert.rejects(task,/public text protocol/)
    else assert.equal(Reflect.get((await task).output[0]!,'type'),'function_call')
  }
})

it('advertises reader capability independently of unchanged database schema',async()=>{
  const {releaseVersions}=await import('../src/versions.js')
  assert.equal(Reflect.get(releaseVersions,'publicText'),2)
  assert.equal(releaseVersions.schema,14)
})
