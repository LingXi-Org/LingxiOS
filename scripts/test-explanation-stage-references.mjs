// Exact request selection and safe parameter failures. No provider or database.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createExplanationStage, parseExplanationDeclaration, readExplanationStage } from '../dist/src/skills/explanation-stage.js'
import { skillActivationTool } from '../dist/src/skills/delivery.js'
import { classifyToolFailure } from '../dist/src/tools/failure.js'
import { compileToolSchemas, validateToolBatch } from '../dist/src/runtime/tool-batch.js'
import { skillIndex } from '../dist/src/skills/definition.js'
import { OpenAIChatDriver } from '../dist/src/model/openai.js'
import { requestItems } from '../dist/src/context/request.js'

const work={id:'run',tenantId:'tenant',principalId:'human',fence:1}
const text='先解释再画对比图。FlashAttention 只搬小块、保留 \nm\n/\nℓ\n/\nO\nm/ℓ/O。再检查 m/ℓ/O。😀'
const request={version:1,workId:'run',tenantId:'tenant',authorId:'human',sourceRef:'human-request',originalText:text,revisions:[]}
const skill={name:'diagram',version:'1',description:'Diagram.',body:'Use authorized tools.',actions:['documents.save'],delivery:{checker:'product:diagram'},workflow:{explanationBeforeAuthoring:{authoringActions:['documents.save']}}}
const index=skillIndex(skill),activationId='a'.repeat(64)
const selection={sourceRef:request.sourceRef}
const declaration=(quote=selection)=>({explanationQuote:quote,authoringQuote:quote,factQuotes:[quote]})
const stage=(value,snapshot=request)=>createExplanationStage(work,snapshot,activationId,['documents.save'],value,index)
const safeFailure=(value,cause,snapshot=request)=>assert.throws(()=>stage(value,snapshot),error=>{
  const failure=classifyToolFailure(error,'transaction')
  assert.equal(failure.code,'invalid_arguments')
  assert.equal(failure.diagnostics.category,'invalid_input')
  assert.equal(failure.diagnostics.causeCode,cause)
  assert.equal(failure.diagnostics.retryable,false,'fix the arguments; do not blindly retry the same action')
  assert.match(failure.message,/Select/)
  assert.equal(classifyToolFailure(error,'input').diagnostics.causeCode,cause)
  assert.match(failure.diagnostics.correlationId,/^[a-f0-9-]{36}$/)
  assert.doesNotMatch(JSON.stringify(failure),/FlashAttention|m\/ℓ\/O|private-marker/)
  assert.deepEqual(classifyToolFailure({code:failure.code,diagnostics:failure.diagnostics},'transaction'),failure)
  return true
})

test('legacy exact multiline text and existing request source IDs resolve to identical immutable quotes',()=>{
  const legacy=stage(declaration(text)),bySource=stage(declaration())
  assert.deepEqual(bySource,legacy)
  assert.equal(bySource.quotes.facts[0].text,text)
  assert.equal(bySource.quotes.facts[0].end,text.length)
})

test('explicit UTF-16 ranges disambiguate repeated exact request fragments',()=>{
  const start=text.lastIndexOf('m/ℓ/O'),range={sourceRef:request.sourceRef,start,end:start+'m/ℓ/O'.length}
  const value=stage(declaration(range))
  assert.deepEqual(value.quotes.facts[0],{...range,text:'m/ℓ/O'})
  safeFailure(declaration('m/ℓ/O'),'explanation_reference_ambiguous')
})

test('rewritten or joined fragments stay rejected with a correctable, private-safe cause',()=>{
  safeFailure(declaration('FlashAttention 只搬小块、保留 m/ℓ/O'),'explanation_reference_not_found')
  safeFailure(declaration('先解释再画对比图。再检查 m/ℓ/O。'),'explanation_reference_not_found')
})

test('only exact current-human source references can be selected',()=>{
  const revisions=[{id:'human-revision',text:'新增事实。',author:{kind:'human',id:'human'}},
    {id:'agent-revision',text:'private-marker',author:{kind:'agent',id:'agent'}},
    {id:'other-human',text:'private-marker',author:{kind:'human',id:'other'}}]
  const snapshot={...request,revisions}
  assert.equal(stage(declaration({sourceRef:'human-revision'}),snapshot).quotes.facts[0].text,'新增事实。')
  for(const sourceRef of ['agent-revision','other-human','foreign-request'])safeFailure(declaration({sourceRef}),'explanation_reference_not_found',snapshot)
  for(const patch of [{tenantId:'foreign'},{workId:'foreign'},{authorId:'foreign'},{parentWorkId:'parent'},{instructionAuthor:{id:'agent'}}])
    assert.throws(()=>stage(declaration(),{...request,...patch}),error=>classifyToolFailure(error,'transaction').diagnostics.category==='authorization')
})

test('empty, out-of-range, partial-pair and surrogate-splitting selections stay rejected',()=>{
  const emoji=text.indexOf('😀')
  for(const quote of [{sourceRef:'human-request',start:0}, {sourceRef:'human-request',start:0,end:0},
    {sourceRef:'human-request',start:-1,end:2}, {sourceRef:'human-request',start:0,end:text.length+1},
    {sourceRef:'human-request',start:emoji,end:emoji+1}, {sourceRef:'human-request',start:emoji+1,end:text.length},
    {sourceRef:'human-request',start:0,end:1,text:'private-marker'}])safeFailure(declaration(quote),'explanation_reference_invalid')
})

test('source-only selection retains the existing size bound and exact selection remains available',()=>{
  const snapshot={...request,originalText:'x'.repeat(2100)}
  safeFailure(declaration(),'explanation_reference_invalid',snapshot)
  assert.equal(stage(declaration({sourceRef:'human-request',start:0,end:100}),snapshot).quotes.facts[0].text.length,100)
})

test('alternate selection forms cannot duplicate the same resolved fact range',()=>{
  safeFailure({...declaration(),factQuotes:[selection,text]},'explanation_reference_invalid')
})

test('parameter repair does not reclassify database faults or authorization denials',()=>{
  const database=classifyToolFailure(new Error('private-marker'),'transaction')
  assert.equal(database.code,'transaction_rolled_back');assert.equal(database.diagnostics.category,'unknown')
  assert.throws(()=>stage(declaration('rewritten')),error=>{
    assert.equal(classifyToolFailure({code:'forbidden',cause:error},'transaction').diagnostics.category,'authorization')
    return true
  })
})

test('activation schema and parser admit selectors, keep explanation optional and reject unknown selection fields',()=>{
  const tool=skillActivationTool([skill],async()=>{})
  compileToolSchemas([tool])
  for(const explanation of [undefined,declaration(),declaration(text),declaration({sourceRef:'human-request',start:0,end:1})]){
    const args={name:index.name,version:index.version,hash:index.hash,...(explanation?{explanation}:{})}
    validateToolBatch([{type:'function_call',callId:'activation',name:tool.name,arguments:JSON.stringify(args)}],[tool],'disabled',false)
    assert.deepEqual(tool.parse(args),args)
  }
  assert.throws(()=>parseExplanationDeclaration(declaration({sourceRef:'human-request',text:'private-marker'})))
})

test('native-v2 sends the strict selector schema and the existing request source unchanged',async()=>{
  const tool=skillActivationTool([skill],async()=>{}),args={name:index.name,version:index.version,hash:index.hash,explanation:declaration()}
  const items=requestItems({...request,attachments:[]})
  const block=JSON.parse(items[0].content)
  assert.equal(block.trust,'request');assert.equal(block.source,request.sourceRef);assert.equal(block.content,text)
  const model=new OpenAIChatDriver('selector-wire',{apiKey:'synthetic-selector-only',maxAttempts:1,
    publicTextProtocol:'purpose-json-v3',publicTextContinuation:'typed-message-v1',publicAnswerTool:'native-v2',
    capabilities:{parallelTools:true,jsonObjectWithTools:false},fetchImpl:async(_url,init)=>{
      const payload=JSON.parse(init.body),exposed=payload.tools.find(value=>value.function.name===tool.name)
      assert.deepEqual(exposed.function.parameters,tool.parameters)
      const toolCalls=[{index:0,id:'public',type:'function',function:{name:'public_answer',arguments:JSON.stringify({operation:{kind:'append',supersedes:[]},answer:'Synthetic explanation.',outcome:null})}},
        {index:1,id:'activate',type:'function',function:{name:tool.name,arguments:JSON.stringify(args)}}]
      return new Response('data: '+JSON.stringify({choices:[{delta:{tool_calls:toolCalls},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n')
    }})
  const result=await model.run({instructions:'Synthetic selection fixture.',items,tools:[tool],codeExecution:'disabled'})
  const activation=result.output.find(item=>item.type==='function_call')
  assert.deepEqual(JSON.parse(activation.arguments),args)
})

test('persisted repeated ranges revalidate without reverting to ambiguous string lookup',async()=>{
  const start=text.lastIndexOf('m/ℓ/O'),value=stage(declaration({sourceRef:'human-request',start,end:start+5}))
  const database={async query(sql){
    if(sql.includes('agent_action_intents'))return {rows:[{skill_name:skill.name,skill_version:skill.version,skill_hash:index.hash,id:activationId,stage:value}]}
    if(sql.includes('agent_request_snapshots'))return {rows:[{request_snapshot:request}]}
    if(sql.includes('agent_steps'))return {rows:[]}
    assert.fail('unexpected query')
  }}
  assert.deepEqual(await readExplanationStage(database,work,1,[skill]),value)
})
