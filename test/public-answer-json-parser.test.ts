import assert from 'node:assert/strict'
import { it } from 'node:test'
import { OpenAIChatDriver } from '../src/model/openai.js'
import type { ToolDefinition } from '../src/tools/catalog.js'
import type { ModelTurnRequest } from '../src/model/driver.js'
import { PUBLIC_ANSWER_TOOL } from '../src/model/public-answer-tool.js'
import { validateToolBatch } from '../src/runtime/tool-batch.js'

const operation={kind:'append',supersedes:[]},outcome={status:'satisfied',gaps:[]}
const known='Gather collects items. Check reviews them.'
const request:ModelTurnRequest={instructions:'Answer using the supplied synthetic facts.',items:[],tools:[{name:'record__read',action:'record.read',description:'Read a synthetic record.',effect:'read',approval:false,parameters:{type:'object',properties:{key:{type:'string'}},required:['key'],additionalProperties:false}}],codeExecution:'disabled'}
const outputTool={name:'public_answer',action:'output.public_answer',description:'Public output binding.',effect:'read' as const,approval:false,parameters:PUBLIC_ANSWER_TOOL.function.parameters as ToolDefinition['parameters']}
const frame=(delta:unknown,finish:string|null=null)=>`data: ${JSON.stringify({choices:[{delta,finish_reason:finish}],usage:{prompt_tokens:20,completion_tokens:10}})}\n\n`
const call=(args:string,name='public_answer',id='output-id',index=0)=>({index,id,type:'function',function:{name,arguments:args}})
const done='data: [DONE]\n\n'
let fixtureIndex=0
function driver(fetchImpl:typeof fetch,publicAnswerTool:'native-v1'|'native-v2'='native-v1'){return new OpenAIChatDriver('public-answer-order',{apiKey:`synthetic-order-${++fixtureIndex}`,maxAttempts:1,publicTextProtocol:'purpose-json-v3',publicTextContinuation:'typed-message-v1',publicAnswerTool,capabilities:{parallelTools:publicAnswerTool==='native-v2',jsonObjectWithTools:false},fetchImpl})}
function run(args:string,extra:Partial<ModelTurnRequest>={}){
  return driver(async()=>new Response(frame({tool_calls:[call(args)]},'tool_calls')+done)).run({...request,...extra})
}
const object=(keys:readonly string[],values:Record<string,unknown>)=>'{'+keys.map(key=>JSON.stringify(key)+':'+JSON.stringify(values[key])).join(',')+'}'
function permutations<T>(values:T[]):T[][]{return values.length?values.flatMap((value,index)=>permutations(values.filter((_,i)=>i!==index)).map(rest=>[value,...rest])):[[]]}

it('accepts every schema-valid root member order with optional commentary at any position',async()=>{
  for(const keys of [...permutations(['operation','answer','outcome']),...permutations(['operation','answer','outcome','commentary'])]){
    const args=object(keys,{operation,answer:known,outcome,commentary:'Public status.'})
    validateToolBatch([{type:'function_call',callId:'output-id',name:'public_answer',arguments:args}],[outputTool],'disabled',false)
    const result=await run(args)
    assert.equal(result.text,known,keys.join(','));assert.deepEqual(result.outcomeDeclaration,outcome)
    assert.equal(result.publicAnswerCall?.arguments,args);assert.deepEqual(result.output,[])
  }
})

it('accepts arbitrary operation and outcome member order, including escaped key spellings',async()=>{
  for(const operationText of ['{"supersedes":[],"kind":"append"}','{"kind":"append","supersedes":[]}']){
    const args='{"answ\\u0065r":'+JSON.stringify(known)+',"outcome":{"gaps":[],"status":"satisfied"},"operation":'+operationText+'}'
    assert.equal((await run(args)).text,known)
  }
})

it('buffers earlier answer until a complete validated late operation, without waiting for the full arguments',async()=>{
  let seen='',operations=0,finished=false,release!:()=>void
  const published=new Promise<void>(resolve=>{release=resolve})
  const model=driver(async()=>new Response(new ReadableStream({async start(controller){
    const send=(args:string,first=false)=>controller.enqueue(new TextEncoder().encode(frame({tool_calls:[first?call(args):{index:0,function:{arguments:args}}]})))
    try{
      send('{"answer":'+JSON.stringify(known),true)
      await new Promise(resolve=>setTimeout(resolve,10));assert.equal(seen,'');assert.equal(operations,0)
      send(',"operation":{"supersedes":[],"kind":"app')
      await new Promise(resolve=>setTimeout(resolve,10));assert.equal(seen,'');assert.equal(operations,0)
      send('end"},')
      await published;assert.equal(finished,false);assert.equal(seen,known);assert.equal(operations,1)
      send('"outcome":{"gaps":[],"status":"satisfied"}}')
      finished=true;controller.enqueue(new TextEncoder().encode(frame({},'tool_calls')+done));controller.close()
    }catch(error){controller.error(error)}
  }})))
  try{const result=await model.run({...request,signal:AbortSignal.timeout(2000),onTextOperation:()=>{operations++},onTextDelta:(text,meta)=>{if(meta?.purpose==='answer'){seen+=text;release()}}});assert.equal(result.text,known)}finally{release()}
})

it('streams partial Unicode strings before closure with commentary later in the object',async()=>{
  const text='Known 😀 facts. 中文. \\ literal / newline\nend',args=JSON.stringify({operation,answer:text,commentary:'Done.',outcome})
  const prefix=args.slice(0,args.indexOf('Known')+6);let seen='',finished=false,release!:()=>void
  const early=new Promise<void>(resolve=>{release=resolve})
  const model=driver(async()=>new Response(new ReadableStream({async start(controller){
    const send=(delta:unknown,finish:string|null=null)=>controller.enqueue(new TextEncoder().encode(frame(delta,finish)))
    try{
      send({tool_calls:[call(prefix)]});await early;assert.equal(finished,false)
      for(const unit of args.slice(prefix.length).split(''))send({tool_calls:[{index:0,function:{arguments:unit}}]})
      finished=true;send({},'tool_calls');controller.enqueue(new TextEncoder().encode(done));controller.close()
    }catch(error){controller.error(error)}
  }})))
  try{const result=await model.run({...request,signal:AbortSignal.timeout(2000),onTextDelta:(part,meta)=>{if(meta?.purpose==='answer'){seen+=part;release()}}});assert.equal(seen,text);assert.equal(result.text,text);assert.equal(result.publicAnswerCall?.arguments,args);assert.doesNotMatch(seen,/\uFFFD/)}finally{release()}
})

const rawOperation=JSON.stringify(operation),rawOutcome=JSON.stringify(outcome)
it('finishes sealed answers with null at every argument split and with single-character deltas',async()=>{
  for(const binding of ['native-v1','native-v2'] as const)for(const keys of permutations(['operation','answer','outcome'])){
    const args=object(keys,{operation,answer:null,outcome})
    const fragments=[...[...args].map((_,index)=>[args.slice(0,index+1),args.slice(index+1)]),args.split('')]
    for(const chunks of fragments){
      const wire=chunks.map((arguments_,index)=>frame({tool_calls:[index===0?call(arguments_):{index:0,function:{arguments:arguments_}}]})).join('')+frame({},'tool_calls')+done
      const seen:string[]=[]
      const result=await driver(async()=>new Response(wire),binding).run({...request,
        answerContext:{messageId:'sealed-answer',segmentIds:['sealed-segment']},onTextDelta:text=>{seen.push(text)},
      })
      assert.deepEqual({text:result.text,outcome:result.outcomeDeclaration,arguments:result.publicAnswerCall?.arguments,seen},
        {text:'',outcome,arguments:args,seen:[]})
    }
  }
})

it('keeps null completion guards and malformed split arguments rejected without public text',async()=>{
  const terminal=JSON.stringify({operation,answer:null,outcome})
  for(const binding of ['native-v1','native-v2'] as const)for(const [args,sealed] of [
    [terminal,false],
    [JSON.stringify({operation,answer:null,outcome:null}),true],
    [JSON.stringify({operation,commentary:null,answer:null,outcome}),true],
    [terminal.slice(0,terminal.indexOf('null')+3),true],
    [terminal.replace('null','null,"answer":null'),true],
    [terminal.replace('null','false'),true],
  ] as const){
    const wire=args.split('').map((arguments_,index)=>frame({tool_calls:[index===0?call(arguments_):{index:0,function:{arguments:arguments_}}]})).join('')+frame({},'tool_calls')+done
    const seen:string[]=[]
    await assert.rejects(driver(async()=>new Response(wire),binding).run({...request,
      ...(sealed?{answerContext:{messageId:'sealed-answer',segmentIds:['sealed-segment']}}:{}),onTextDelta:text=>{seen.push(text)},
    }))
    assert.deepEqual(seen,[])
  }
})

const invalid:Record<string,string>={
  'duplicate answer':'{"operation":'+rawOperation+',"answer":"first","answer":"second","outcome":'+rawOutcome+'}',
  'escaped duplicate answer':'{"operation":'+rawOperation+',"answer":"first","answ\\u0065r":"second","outcome":'+rawOutcome+'}',
  'duplicate operation':'{"operation":'+rawOperation+',"answer":"x","operation":'+rawOperation+',"outcome":'+rawOutcome+'}',
  'duplicate commentary':'{"operation":'+rawOperation+',"commentary":"one","answer":"x","commentary":"two","outcome":'+rawOutcome+'}',
  'duplicate outcome':'{"operation":'+rawOperation+',"answer":"x","outcome":'+rawOutcome+',"outcome":'+rawOutcome+'}',
  'nested duplicate kind':'{"operation":{"kind":"append","supersedes":[],"kind":"replace"},"answer":"x","outcome":'+rawOutcome+'}',
  'nested duplicate supersedes':'{"operation":{"kind":"append","supersedes":[],"supersedes":[]},"answer":"x","outcome":'+rawOutcome+'}',
  'nested duplicate status':'{"operation":'+rawOperation+',"answer":"x","outcome":{"status":"satisfied","gaps":[],"status":"blocked"}}',
  'nested duplicate gaps':'{"operation":'+rawOperation+',"answer":"x","outcome":{"status":"satisfied","gaps":[],"gaps":[]}}',
  'unknown root':'{"operation":'+rawOperation+',"answer":"x","outcome":'+rawOutcome+',"secret":"private"}',
  'unknown operation':'{"operation":{"kind":"append","supersedes":[],"extra":1},"answer":"x","outcome":'+rawOutcome+'}',
  'unknown outcome':'{"operation":'+rawOperation+',"answer":"x","outcome":{"status":"satisfied","gaps":[],"extra":1}}',
  'answer object':JSON.stringify({operation,answer:{text:'not a string'},outcome}),
  'commentary array':JSON.stringify({operation,answer:'x',commentary:[],outcome}),
  'operation array':JSON.stringify({operation:[],answer:'x',outcome}),
  'wrong gaps type':JSON.stringify({operation,answer:'x',outcome:{status:'satisfied',gaps:'none'}}),
  'invalid append targets':JSON.stringify({operation:{kind:'append',supersedes:['old']},answer:'x',outcome}),
  'satisfied with gaps':JSON.stringify({operation,answer:'x',outcome:{status:'satisfied',gaps:['incomplete']}}),
  'partial without gap':JSON.stringify({operation,answer:'x',outcome:{status:'partial',gaps:[]}}),
  'truncated':JSON.stringify({operation,answer:'x',outcome}).slice(0,-1),
  'trailing text':JSON.stringify({operation,answer:'x',outcome})+'private tail',
  'invalid escape':'{"operation":'+rawOperation+',"answer":"bad\\q","outcome":'+rawOutcome+'}',
  'lone escaped high surrogate':'{"operation":'+rawOperation+',"answer":"\\ud83dX","outcome":'+rawOutcome+'}',
  'lone escaped low surrogate':'{"operation":'+rawOperation+',"answer":"\\ude00","outcome":'+rawOutcome+'}',
  'empty intermediate':JSON.stringify({operation,answer:'',outcome:null}),
  'null intermediate':JSON.stringify({operation,answer:null,outcome:null}),
}
for(const [label,args] of Object.entries(invalid))it(`rejects ${label} without producing a successful native result`,async()=>{await assert.rejects(run(args))})

it('a late invalid operation releases none of the earlier buffered answer',async()=>{
  let seen='';await assert.rejects(run(JSON.stringify({answer:known,operation:{kind:'append',supersedes:['foreign']},outcome}),{onTextDelta:text=>{seen+=text}}));assert.equal(seen,'')
})

it('cancellation at the delayed operation boundary releases no buffered text',async()=>{
  const stop=new AbortController();let seen='',operations=0
  await assert.rejects(run(JSON.stringify({answer:known,operation,outcome}),{signal:stop.signal,onTextOperation:()=>{operations++;stop.abort()},onTextDelta:text=>{seen+=text}}));assert.equal(seen,'');assert.equal(operations,1)
})

it('keeps the original mixed and duplicate native batch invalid after accepting arbitrary member order',async()=>{
  const args=JSON.stringify({answer:known,commentary:'Public status.',outcome,operation})
  for(const second of [call('{"key":"value"}','record__read','business',1),call(args,'public_answer','other-output',1)]){
    let resolved=false
    const model=driver(async()=>new Response(frame({tool_calls:[call(args),second]},'tool_calls')+done))
    await assert.rejects(model.run(request).then(result=>{resolved=true;return result}));assert.equal(resolved,false)
  }
})

it('ordinary content and reasoning remain private beside an unordered explicit output binding',async()=>{
  const args=JSON.stringify({answer:known,outcome,operation,commentary:'Public status.'});const seen:Array<{text:string;purpose:unknown}>=[]
  const model=driver(async()=>new Response(frame({content:'Private ordinary content.',reasoning_content:'Private reasoning.'})+frame({tool_calls:[call(args)]},'tool_calls')+done))
  const result=await model.run({...request,onTextDelta:(text,meta)=>{seen.push({text,purpose:meta?.purpose})}})
  assert.equal(result.text,known);assert.doesNotMatch(JSON.stringify({result,seen}),/Private ordinary|Private reasoning/)
})

it('rejects a non-string operation kind before publishing operation metadata or buffered answer',async()=>{
  let operations=0,seen=''
  await assert.rejects(run(JSON.stringify({answer:known,operation:{kind:['replace'],supersedes:['old']},outcome}),{
    onTextOperation:()=>{operations++},onTextDelta:text=>{seen+=text},
  }))
  assert.equal(operations,0);assert.equal(seen,'')
})
