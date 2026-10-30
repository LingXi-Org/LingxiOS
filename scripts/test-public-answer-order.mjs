import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OpenAIChatDriver } from '../dist/src/model/openai.js'
import { ModelDriverError } from '../dist/src/errors.js'
import { publicModelDiagnostics } from '../dist/src/model/diagnostics.js'
import { modelProtocolCorrection } from '../dist/src/runtime/protocol-correction.js'

const business={name:'record__read',action:'record.read',effect:'read',approval:false,
  description:'Read a synthetic record.',parameters:{type:'object',properties:{key:{type:'string'}},required:['key'],additionalProperties:false}}
const request={instructions:'Use supplied synthetic facts.',items:[],tools:[business],codeExecution:'disabled'}
const args=JSON.stringify({operation:{kind:'append',supersedes:[]},answer:'Known synthetic fact.',outcome:null})
const call=(index,name,argumentsText,id='call-'+index)=>({index,id,type:'function',function:{name,arguments:argumentsText}})
const frame=calls=>'data: '+JSON.stringify({choices:[{delta:{tool_calls:calls},finish_reason:'tool_calls'}],usage:{prompt_tokens:20,completion_tokens:10}})+'\n\ndata: [DONE]\n\n'
const options={apiKey:'synthetic-order-regression',maxAttempts:1,publicTextProtocol:'purpose-json-v3',publicTextContinuation:'typed-message-v1',capabilities:{parallelTools:true,jsonObjectWithTools:false}}

test('native-v2 catalog and budget estimate put mandatory output first without changing business schemas',async()=>{
  let estimated,wire
  const model=new OpenAIChatDriver('order-catalog',{...options,publicAnswerTool:'native-v2',countTokens:text=>{estimated=text;return text.length},fetchImpl:async(_url,init)=>{
    wire=JSON.parse(init.body)
    return new Response(frame([call(0,'public_answer',args),call(1,business.name,'{"key":"v"}')]))
  }})
  model.generationInputTokens(request);const estimate=JSON.parse(estimated)
  await model.run(request)
  assert.deepEqual(wire.tools.map(tool=>tool.function.name),['public_answer',business.name])
  assert.deepEqual(wire.tools[1].function.parameters,business.parameters)
  assert.deepEqual(estimate.tools,wire.tools);assert.deepEqual(estimate.messages,wire.messages)
  assert.equal(wire.tool_choice,'auto');assert.equal(wire.parallel_tool_calls,true)
  assert.match(wire.tools[0].function.description,/Required FIRST native call in EVERY generation/)
})

for(const [detail,calls,phrase] of [
  ['public_answer_missing',[call(0,business.name,'{"key":"private-marker"}')],/did not include public_answer/],
  ['public_answer_misordered',[call(0,business.name,'{"key":"private-marker"}'),call(1,'public_answer',args)],/placed public_answer after a business call/],
])test(`native-v2 ${detail} remains rejected with safe specific correction`,async()=>{
  const deltas=[]
  const model=new OpenAIChatDriver('order-'+detail,{...options,publicAnswerTool:'native-v2',fetchImpl:async()=>new Response(frame(calls))})
  await assert.rejects(model.run({...request,onTextDelta:text=>{deltas.push(text)}}),error=>{
    assert.ok(error instanceof ModelDriverError)
    const safe=publicModelDiagnostics(error.diagnostics)
    assert.equal(safe.protocolCode,'public_answer_first_required');assert.equal(safe.protocolDetail,detail)
    assert.deepEqual(safe.finishReasons,['tool_calls']);assert.equal(error.diagnostics.usage.inputTokens,20)
    const correction=modelProtocolCorrection(error.diagnostics,'disabled','purpose-json-v3')
    assert.match(correction.content,phrase);assert.match(correction.content,/not dispatched/)
    assert.doesNotMatch(JSON.stringify({safe,correction}),/private-marker|record__read/)
    return true
  })
  assert.deepEqual(deltas,[])
})

test('native-v1 still permits a business-only turn and preserves its catalog order',async()=>{
  const model=new OpenAIChatDriver('order-v1',{...options,publicAnswerTool:'native-v1',capabilities:{parallelTools:false,jsonObjectWithTools:false},fetchImpl:async(_url,init)=>{
    assert.deepEqual(JSON.parse(init.body).tools.map(tool=>tool.function.name),[business.name,'public_answer'])
    return new Response(frame([call(0,business.name,'{"key":"v"}')]))
  }})
  await model.run(request)
  assert.deepEqual(publicModelDiagnostics({protocolDetail:'private-marker'}),{})
})
