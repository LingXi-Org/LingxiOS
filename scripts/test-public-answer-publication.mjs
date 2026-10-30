// Owning regression only. Run after npm run build; no provider, database or browser.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OpenAIChatDriver } from '../dist/src/model/openai.js'
import { PublicTextAttemptWriter, PublicTextSafetyError } from '../dist/src/runtime/public-text.js'
import { ModelDriverError } from '../dist/src/errors.js'
import { publicModelDiagnostics } from '../dist/src/model/diagnostics.js'
import { modelProtocolCorrection } from '../dist/src/runtime/protocol-correction.js'

const operation={kind:'append',supersedes:[]},outcome={status:'satisfied',gaps:[]}
const answer='Q 与 K 的得分经 softmax 得到权重，再加权 V。',commentary='接下来保存交互视图。'
const identity={version:1,requestVersion:1,fence:1,attemptId:'attempt',partId:'part',partIndex:0}
const frame=(delta,finish=null)=>`data: ${JSON.stringify({choices:[{delta,finish_reason:finish}],usage:{prompt_tokens:20,completion_tokens:10}})}\n\n`
const call=(args,name='public_answer')=>({index:0,id:'output',type:'function',function:{name,arguments:args}})
const done='data: [DONE]\n\n'
const request={instructions:'Use the supplied synthetic facts.',items:[],tools:[{name:'record__read',action:'record.read',description:'Read a synthetic record.',effect:'read',approval:false,parameters:{type:'object',properties:{},additionalProperties:false}}],codeExecution:'disabled'}
let counter=0
const driver=fetchImpl=>new OpenAIChatDriver('member-order-regression',{apiKey:`synthetic-${++counter}`,maxAttempts:1,
  publicTextProtocol:'purpose-json-v3',publicTextContinuation:'typed-message-v1',publicAnswerTool:'native-v2',
  capabilities:{parallelTools:true,jsonObjectWithTools:false},fetchImpl})
const permutations=xs=>xs.length?xs.flatMap((x,i)=>permutations(xs.filter((_,j)=>i!==j)).map(rest=>[x,...rest])):[[]]
const object=(keys,values)=>'{'+keys.map(key=>JSON.stringify(key)+':'+JSON.stringify(values[key])).join(',')+'}'
function publication(assess,protocol='purpose-json-v3'){
  const events=[]
  const writer=new PublicTextAttemptWriter(identity,async event=>{events.push(event)},new AbortController().signal,assess,protocol)
  return {writer,events,callbacks:{onTextOperation:op=>writer.begin(op),onTextDelta:(text,metadata)=>writer.push(text,metadata)}}
}
const text=(events,purpose)=>events.filter(e=>e.kind==='public.text.delta'&&e.data.purpose===purpose).map(e=>e.data.text).join('')
const wire=args=>args.split('').map((part,index)=>frame({tool_calls:[index===0?call(part):{index:0,function:{arguments:part}}]})).join('')+frame({},'tool_calls')+done

for(const keys of permutations(['operation','answer','commentary','outcome']))test(`durable publication accepts ${keys.join(',')}`,async()=>{
  const p=publication(),args=object(keys,{operation,answer,commentary,outcome})
  try{
    const result=await driver(async()=>new Response(wire(args))).run({...request,...p.callbacks})
    await p.writer.finish(result.text);await p.writer.end('completed');await p.writer.seal(result.text)
    assert.equal(text(p.events,'answer'),answer);assert.equal(text(p.events,'commentary'),commentary)
    assert.deepEqual(result.outcomeDeclaration,outcome)
    assert.equal(p.events.filter(e=>e.kind==='public.text.sealed').length,1)
  }finally{p.writer.dispose()}
})

test('answer still reaches durable publication before its closing quote and late commentary',async()=>{
  const p=publication(),args=JSON.stringify({operation,answer,commentary,outcome})
  const cut=args.indexOf('Q 与')+3
  const body=new ReadableStream({async start(controller){
    const send=data=>controller.enqueue(new TextEncoder().encode(data))
    try{
      send(frame({tool_calls:[call(args.slice(0,cut))]}))
      // Stream cannot produce the rest until the writer acknowledges the answer.
      for(let i=0;i<50&&!text(p.events,'answer');i++)await new Promise(resolve=>setTimeout(resolve,5))
      assert.ok(text(p.events,'answer'));assert.equal(text(p.events,'commentary'),'')
      send(frame({tool_calls:[{index:0,function:{arguments:args.slice(cut)}}]},'tool_calls')+done);controller.close()
    }catch(error){controller.error(error)}
  }})
  try{const result=await driver(async()=>new Response(body)).run({...request,...p.callbacks,signal:AbortSignal.timeout(2000)});assert.equal(result.text,answer)}finally{p.writer.dispose()}
})

for(const args of [
  JSON.stringify({operation,answer,commentary:null,outcome}),
  JSON.stringify({operation,answer,commentary,outcome}).replace('"outcome":','"answer":"duplicate","outcome":'),
  JSON.stringify({operation,answer,commentary,outcome,unknown:true}),
  JSON.stringify({operation,answer,commentary,outcome}).slice(0,-1),
  '{"operation":{"kind":"append","supersedes":[]},"answer":"bad\\q","outcome":null}',
])test('invalid native JSON never seals a public result',async()=>{
  const p=publication()
  try{await assert.rejects(driver(async()=>new Response(wire(args))).run({...request,...p.callbacks}));assert.equal(p.events.some(e=>e.kind==='public.text.sealed'),false)}finally{p.writer.dispose()}
})

test('late commentary still passes the safety policy',async()=>{
  const p=publication(({text})=>text.startsWith("接")?{safeThrough:0,reject:'unsafe_content'}:{safeThrough:text.length})
  try{
    await assert.rejects(driver(async()=>new Response(wire(JSON.stringify({operation,answer,commentary,outcome})))).run({...request,...p.callbacks}),error=>{
      for(let e=error;e instanceof Error;e=e.cause)if(e instanceof PublicTextSafetyError)return true
      return false
    })
    assert.equal(text(p.events,'commentary'),'');assert.equal(p.events.some(e=>e.kind==='public.text.sealed'),false)
  }finally{p.writer.dispose()}
})

test('legacy order and invalid purpose stay rejected with closed diagnostic codes',async()=>{
  for(const protocol of ['purpose-json-v1','purpose-json-v2','purpose-json-v3']){
    const p=publication(undefined,protocol)
    const rejected=error=>{
      assert.ok(error instanceof ModelDriverError)
      assert.deepEqual(publicModelDiagnostics({...error.diagnostics,raw:'must not survive'}),{kind:'protocol',category:'protocol',protocolCode:'public_text_invalid',finishReasons:[]})
      assert.equal(modelProtocolCorrection(error.diagnostics,'disabled',protocol).category,'response_protocol');return true
    }
    try{await assert.rejects(p.writer.push('missing purpose'),rejected)
      if(protocol!=='purpose-json-v3'){await p.writer.push(answer,{purpose:'answer'});await assert.rejects(p.writer.push(commentary,{purpose:'commentary'}),rejected)}
    }finally{p.writer.dispose()}
  }
})

test('unknown function names receive tool diagnostics and exact-name correction',async()=>{
  const model=driver(async(_url,init)=>{
    const payload=JSON.parse(init.body)
    assert.match(payload.messages[0].content,/never start the next generation with a business call alone/)
    assert.match(payload.messages[0].content,/exact function.name identifiers/)
    return new Response(frame({tool_calls:[call('{}','record.read')]},'tool_calls')+done)
  })
  await assert.rejects(model.run(request),error=>{
    assert.ok(error instanceof ModelDriverError)
    assert.equal(publicModelDiagnostics(error.diagnostics).protocolCode,'tool_identity_invalid')
    const correction=modelProtocolCorrection(error.diagnostics,'disabled','purpose-json-v3')
    assert.equal(correction.category,'tool_protocol');assert.match(correction.content,/exact function.name identifiers/)
    assert.doesNotMatch(correction.content,/record.read/);return true
  })
})

test('business-only native-v2 batch keeps usage and explains the missing output binding',async()=>{
  const model=driver(async()=>new Response(frame({tool_calls:[call('{}','record__read')]},'tool_calls')+done))
  await assert.rejects(model.run(request),error=>{
    assert.ok(error instanceof ModelDriverError)
    const safe=publicModelDiagnostics(error.diagnostics)
    assert.equal(safe.protocolCode,'public_answer_first_required');assert.deepEqual(safe.finishReasons,['tool_calls'])
    assert.equal(safe.usage.inputTokens,20)
    const correction=modelProtocolCorrection(error.diagnostics,'disabled','purpose-json-v3')
    assert.equal(correction.category,'response_protocol');assert.match(correction.content,/not dispatched/)
    assert.match(correction.content,/SAME generation/);assert.doesNotMatch(correction.content,/record__read/);return true
  })
})

test('structural rejection details are closed, precise and contain no rejected values',async()=>{
  for(const [args,detail] of [
    [JSON.stringify({operation,answer:{private:'marker'},outcome}),'answer_type'],
    [JSON.stringify({operation,answer,commentary:null,outcome}),'commentary_type'],
    [JSON.stringify({operation:'append',answer,outcome}),'operation_invalid'],
    [JSON.stringify({operation,answer,outcome:{status:'satisfied',gaps:['marker']}}),'outcome_invalid'],
    [JSON.stringify({operation,answer,outcome,private:'marker'}),'unknown_field'],
    ['{"operation":{"kind":"append","supersedes":[]},"answer":"bad\\q","outcome":null}','json_syntax'],
  ])await assert.rejects(driver(async()=>new Response(wire(args))).run(request),error=>{
    assert.ok(error instanceof ModelDriverError)
    const safe=publicModelDiagnostics(error.diagnostics)
    assert.equal(safe.protocolDetail,detail);assert.doesNotMatch(JSON.stringify(safe),/marker|private|bad\\q/);return true
  })
  assert.deepEqual(publicModelDiagnostics({protocolDetail:'private-marker'}),{})
})

test('unknown tool names and duplicate IDs retain distinct safe rejection reasons',async()=>{
  for(const [name,id,detail] of [['unexposed','second','tool_name_unknown'],['record__read','output','tool_id_duplicate']]){
    const model=driver(async()=>new Response(frame({tool_calls:[call(JSON.stringify({operation,answer,outcome:null})),
      {index:1,id,type:'function',function:{name,arguments:'{}'}}]},'tool_calls')+done))
    await assert.rejects(model.run(request),error=>{assert.ok(error instanceof ModelDriverError);assert.equal(publicModelDiagnostics(error.diagnostics).protocolDetail,detail);return true})
  }
})
