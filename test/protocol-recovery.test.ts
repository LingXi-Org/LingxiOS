import assert from 'node:assert/strict'
import { it } from 'node:test'
import { OpenAIChatDriver, sseDataEvents } from '../src/model/openai.js'
import { ModelDriverError } from '../src/errors.js'
import { publicModelDiagnostics } from '../src/model/diagnostics.js'

// Failure inventory: docs/issue-332-protocol-failure-model.md. Synthetic wire only.
const stream=(chunks:string[])=>new ReadableStream<Uint8Array>({start(controller){
  for(const chunk of chunks)controller.enqueue(new TextEncoder().encode(chunk))
  controller.close()
}})
const frame=(content:string,finish:string|null=null,separator='\n\n')=>'data: '+JSON.stringify({
  choices:[{delta:{content,reasoning_content:'PRIVATE_REASONING_SENTINEL'},finish_reason:finish}],
})+separator

it('preserves SSE events with every supported LF/CRLF delimiter and every network split',async()=>{
  for(const separator of ['\n\n','\r\n\r\n','\r\n\n','\n\r\n']){
    const wire='data: first'+separator+'data: second\n\n'
    for(let split=0;split<=wire.length;split++){
      const actual=[]
      for await(const data of sseDataEvents(stream([wire.slice(0,split),wire.slice(split)])))actual.push(data)
      assert.deepEqual(actual,['first','second'],`delimiter=${JSON.stringify(separator)}, split=${split}`)
    }
  }
})

it('decodes a complete purpose answer across mixed SSE line endings without a correction',async()=>{
  for(const separator of ['\r\n\n','\n\r\n']){
    const wire=frame('{"commentary":"","answer":"',null,separator)+frame('ok"}')+frame('','stop')+'data: [DONE]\n\n'
    for(const chunks of [[wire],[...wire]]){
    const model=new OpenAIChatDriver('sse-purpose-fixture',{apiKey:'fixture',maxAttempts:1,publicTextProtocol:'purpose-json-v1',fetchImpl:async()=>new Response(stream(chunks))})
    const result=await model.run({instructions:'Say ok.',items:[],codeExecution:'disabled'})
    assert.equal(result.text,'ok')
    assert.deepEqual(result.diagnostics?.['finishReasons'],['stop'])
    }
  }
})

for(const scenario of [
  {name:'answer_required',text:'{"commentary":"Checking","answer":""}',code:'public_text_answer_required'},
  {name:'incomplete',text:'{"commentary":"Checking","answer":"',code:'public_text_incomplete'},
  {name:'invalid',text:'{"answer":"PRIVATE_BODY_SENTINEL","commentary":""}',code:'public_text_invalid'},
  {name:'tool_identity',text:'{"commentary":"","answer":""}',code:'tool_identity_invalid'},
  {name:'legacy_empty',text:'',code:'response_empty'},
])for(const measured of [true,false])it(`protocol cause ${scenario.name} retains observed stop and ${measured?'measured':'unavailable'} usage`,async()=>{
  const model=new OpenAIChatDriver('protocol-diagnostics-fixture',{apiKey:'fixture',maxAttempts:1,
    ...(scenario.name==='legacy_empty'?{}:{publicTextProtocol:'purpose-json-v1' as const}),fetchImpl:async()=>new Response('data: '+JSON.stringify({
      choices:[{delta:{content:scenario.text,...scenario.name==='tool_identity'?{tool_calls:[{index:0,id:'call',function:{name:'not_exposed',arguments:'{}'}}]}:{}},finish_reason:'stop'}],
      ...measured?{usage:{prompt_tokens:17,completion_tokens:9}}:{},
    })+'\n\ndata: [DONE]\n\n')})
  await assert.rejects(model.run({instructions:'fixture',items:[],codeExecution:'disabled'}),error=>{
    assert.ok(error instanceof ModelDriverError)
    const safe=publicModelDiagnostics(error.diagnostics)
    assert.equal(safe['kind'],'protocol')
    assert.equal(safe['protocolCode'],scenario.code)
    assert.deepEqual(safe['finishReasons'],['stop'])
    assert.equal(error.diagnostics.usage?.available??false,measured)
    if(measured)assert.deepEqual(safe['usage'],{available:true,inputTokens:17,outputTokens:9})
    assert.doesNotMatch(JSON.stringify(safe),/PRIVATE_BODY_SENTINEL|PRIVATE_REASONING_SENTINEL/)
    return true
  })
})

it('only exposes known fixed protocol codes, never arbitrary driver extensions',()=>{
  assert.deepEqual(publicModelDiagnostics({kind:'protocol',protocolCode:'PRIVATE_BODY_SENTINEL',raw:'PRIVATE_BODY_SENTINEL'}),{kind:'protocol'})
  assert.deepEqual(publicModelDiagnostics({kind:'protocol',protocolCode:'public_text_incomplete',raw:'PRIVATE_BODY_SENTINEL'}),{kind:'protocol',protocolCode:'public_text_incomplete'})
})

for (const protocolCode of ['native_envelope_invalid','terminal_outcome_required']) it(`preserves fixed public diagnostic ${protocolCode}`,()=>{
  assert.deepEqual(publicModelDiagnostics({kind:'protocol',protocolCode,raw:'PRIVATE_BODY_SENTINEL'}),{kind:'protocol',protocolCode})
})
