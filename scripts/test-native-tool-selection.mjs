import assert from 'node:assert/strict'
import {test} from 'node:test'
import {OpenAIChatDriver} from '../dist/src/model/openai.js'
import {executionSnapshot} from '../dist/src/runtime/execution-policy.js'
import {DefaultRuntimePolicy} from '../dist/src/runtime/policy.js'
const tool={name:'record__read',action:'record.read',description:'Read a synthetic record',parameters:{type:'object',properties:{key:{type:'string'}},required:['key'],additionalProperties:false},effect:'read',approval:false}
const request={instructions:'Use only the supplied synthetic record.',items:[],tools:[tool],codeExecution:'disabled'}
const call=(index,name,args)=>({index,id:'call-'+index,type:'function',function:{name,arguments:JSON.stringify(args)}})
const output={operation:{kind:'append',supersedes:[]},answer:'Synthetic answer.',outcome:null}
const frame=calls=>'data: '+JSON.stringify({choices:[{delta:{tool_calls:calls},finish_reason:'tool_calls'}],usage:{prompt_tokens:20,completion_tokens:10}})+'\n\ndata: [DONE]\n\n'
const options={apiKey:'unit-only',maxAttempts:1,publicTextProtocol:'purpose-json-v3',publicTextContinuation:'typed-message-v1',publicAnswerTool:'native-v3',capabilities:{parallelTools:true,jsonObjectWithTools:false}}
const driver=calls=>new OpenAIChatDriver('synthetic', {...options,fetchImpl:async()=>new Response(frame(calls))})
test('native-v3 permits original-schema business-only batches without inventing public output',async()=>{
 const result=await driver([call(0,tool.name,{key:'one'}),call(1,tool.name,{key:'two'})]).run(request)
 assert.equal(result.output.length,2);assert.equal(result.text,'');assert.equal(result.publicAnswerCall,undefined)
 assert.deepEqual(result.output.map(item=>JSON.parse(item.arguments)),[{key:'one'},{key:'two'}])
})
test('native-v3 keeps public output first when present and rejects misordering, bad fields and unknown tools',async()=>{
 assert.equal((await driver([call(0,'public_answer',output),call(1,tool.name,{key:'one'})]).run(request)).text,'Synthetic answer.')
 for(const calls of [[call(0,tool.name,{key:'one'}),call(1,'public_answer',output)],[call(0,tool.name,{wrong:'one'})],[call(0,'unknown__read',{key:'one'})]])await assert.rejects(driver(calls).run(request))
})
test('required tool comes from authorized execution and its wire estimate matches actual provider choice',async()=>{
 const context={work:{meta:{mode:'execute'}},tools:[tool],grants:[{name:'record',methods:['read']}],capabilities:['record']}
 const policy=new DefaultRuntimePolicy();policy.requiredTool=()=>tool.name
 assert.equal(executionSnapshot(context,policy).requiredTool,tool.name)
 policy.requiredTool=()=> 'outside__write';assert.throws(()=>executionSnapshot(context,policy),/required tool/)
 let wire,estimate
 const model=new OpenAIChatDriver('selection',{...options,countTokens:text=>{if(text.startsWith('{'))estimate=JSON.parse(text);return text.length},fetchImpl:async(_,init)=>{wire=JSON.parse(init.body);return new Response(frame([call(0,tool.name,{key:'one'})]))}})
 const selected={...request,requiredTool:tool.name};model.generationInputTokens(selected);await model.run(selected)
 assert.deepEqual(wire.tool_choice,{type:'function',function:{name:tool.name}});assert.deepEqual(estimate.tool_choice,wire.tool_choice)
 await assert.rejects(model.run({...selected,requiredTool:'outside__write'}),/required tool/)
})
