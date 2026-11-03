import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OpenAIChatDriver } from '../dist/src/model/openai.js'
import { modelProtocolCorrection } from '../dist/src/runtime/protocol-correction.js'
import { publicModelDiagnostics } from '../dist/src/model/diagnostics.js'
const tool={name:'record__read',action:'record.read',description:'Read',effect:'read',approval:false,parameters:{type:'object',properties:{},additionalProperties:false}}
const request={instructions:'Synthetic only',items:[],tools:[tool],codeExecution:'disabled'}
const options={apiKey:'synthetic',maxAttempts:1,publicTextProtocol:'purpose-json-v3',publicTextContinuation:'typed-message-v1',publicAnswerTool:'native-v3',capabilities:{jsonObjectWithTools:false,parallelTools:true}}
const answer={operation:{kind:'append',supersedes:[]},answer:'Synthetic answer',outcome:{status:'satisfied',gaps:[]}}
const call=(index,name,args)=>({index,id:'call-'+index,type:'function',function:{name,arguments:JSON.stringify(args)}})
const wire=(calls)=>'data: '+JSON.stringify({choices:[{delta:calls?{tool_calls:calls}:{content:'plain rejected answer'},finish_reason:calls?'tool_calls':'stop'}],usage:{prompt_tokens:12,completion_tokens:8}})+'\n\ndata: [DONE]\n\n'
test('native-v3 requires a native choice from the whole catalog, including terminal and tool-only turns',async()=>{
 for(const [tools,calls] of [[[tool],[call(0,tool.name,{})]],[[],[call(0,'public_answer',answer)]],[[tool],[call(0,'public_answer',{...answer,outcome:null}),call(1,tool.name,{})]]]){
  let sent,estimated
  const model=new OpenAIChatDriver('required-contract',{...options,countTokens:text=>{if(text.startsWith('{'))estimated=JSON.parse(text);return text.length},fetchImpl:async(_,init)=>{sent=JSON.parse(init.body);return new Response(wire(calls))}})
  const input={...request,tools};model.generationInputTokens(input);await model.run(input)
  assert.equal(sent.tool_choice,'required');assert.equal(estimated.tool_choice,'required')
  assert.deepEqual(sent.tools.map(t=>t.function.name),['public_answer',...tools.map(t=>t.name)])
 }
})
test('no-call refusal retains billable usage and gives an accurate native-channel correction',async()=>{
 const model=new OpenAIChatDriver('no-call',{...options,fetchImpl:async()=>new Response(wire())})
 await assert.rejects(model.run(request),error=>{
  assert.equal(error.diagnostics.protocolDetail,'native_call_missing')
  assert.equal(error.diagnostics.usage.outputTokens,8)
  const correction=modelProtocolCorrection(error.diagnostics,'disabled','purpose-json-v3')
  assert.match(correction.content,/public_answer/);assert.match(correction.content,/tool_calls/)
  assert.match(correction.content,/not dispatched/);assert.doesNotMatch(correction.content,/plain rejected answer/)
  return true
 })
})
test('an explicitly unsupported required choice is a configuration error before HTTP',()=>{
 assert.throws(()=>new OpenAIChatDriver('unsupported',{...options,capabilities:{...options.capabilities,requiredToolChoice:false}}),/required tool choice/)
})
test('invalid operations and metadata expose only closed structural reasons',async()=>{
 const cases=[
  [[call(0,'public_answer',{...answer,operation:{kind:'private-marker',supersedes:[]}})],'operation_kind_invalid'],
  [[call(0,'public_answer',{...answer,operation:{kind:'replace',supersedes:[]}})],'operation_supersedes_invalid'],
  [[{...call(0,tool.name,{}),type:'private-marker'}],'tool_type_invalid'],
  [[{...call(0,tool.name,{}),index:-1}],'tool_index_invalid'],
 ]
 for(const [calls,detail] of cases){
  const model=new OpenAIChatDriver('closed-reason',{...options,fetchImpl:async()=>new Response(wire(calls))})
  await assert.rejects(model.run(request),error=>{const safe=publicModelDiagnostics(error.diagnostics);assert.equal(safe.protocolDetail,detail);assert.doesNotMatch(JSON.stringify(safe),/private-marker/);return true})
 }
})
