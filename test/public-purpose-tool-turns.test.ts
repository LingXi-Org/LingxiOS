import assert from 'node:assert/strict'
import { it } from 'node:test'
import { OpenAIChatDriver } from '../src/model/openai.js'
import { PUBLIC_PURPOSE_V2_INSTRUCTIONS, publicPurposeInstructions } from '../src/model/public-purpose.js'
import { ModelDriverError } from '../src/errors.js'
import type { ToolDefinition } from '../src/tools/catalog.js'

const tool: ToolDefinition = { name: 'fixture__read', action: 'fixture.read', description: 'Read a synthetic value.',
  effect: 'read', approval: false, parameters: { type: 'object', properties: {}, additionalProperties: false } }
const operation = { kind: 'append', supersedes: [] }
const final = { status: 'satisfied', gaps: [] }
const frame = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({choices:[{delta,finish_reason}]})}\n\n`
const toolTurnExample = '{"operation":{"kind":"append","supersedes":[]},"commentary":"","answer":"The supplied numbers total 5. ","outcome":null}'
const sealedFinalExample = '{"operation":{"kind":"append","supersedes":[]},"commentary":"","answer":null,"outcome":{"status":"satisfied","gaps":[]}}'

it('sends complete same-turn examples and the single-call constraint without adding a model round', async () => {
  let calls = 0
  const seen: unknown[] = []
  const model: OpenAIChatDriver = new OpenAIChatDriver('purpose-tool-turn-fixture', { apiKey: 'synthetic', maxAttempts: 1,
    publicTextProtocol: 'purpose-json-v3', maxThinkingTokens: 0, capabilities: { jsonObjectWithTools: false, parallelTools: false },
    fetchImpl: async (_url, init) => {
      calls++
      const body = JSON.parse(String(init?.body))
      const instructions = String(body.messages[0].content)
      assert.ok(instructions.includes(toolTurnExample))
      assert.ok(instructions.includes(sealedFinalExample))
      assert.match(instructions, /at most ONE native tool call/)
      assert.match(instructions, /not permission to send plain text/)
      assert.match(instructions, /only the number.*constrain the answer field itself/)
      assert.equal(model.protocolTokens, model.countTokens(instructions.slice('Synthetic request.\n\n'.length)))
      assert.equal(Object.hasOwn(body, 'response_format'), false)
      assert.equal(body.parallel_tool_calls, false)
      assert.equal(body.tools.length, 1)
      return new Response(frame({content:JSON.stringify({operation,commentary:'',answer:'Known A. ',outcome:null})})
        + frame({tool_calls:[{index:0,id:'read-once',type:'function',function:{name:tool.name,arguments:'{}'}}]},'tool_calls')
        + 'data: [DONE]\n\n')
    } })
  const result = await model.run({instructions:'Synthetic request.',items:[],tools:[tool],codeExecution:'disabled',
    onTextOperation:value=>{seen.push(value)},onTextDelta:value=>{seen.push(value)}})
  assert.equal(calls,1)
  assert.deepEqual(seen,[operation,'Known A. '])
  assert.equal(result.text,'Known A. ')
  assert.equal(result.outcomeDeclaration,undefined)
  assert.deepEqual(result.output,[{role:'assistant',content:'Known A. '},{type:'function_call',callId:'read-once',name:tool.name,arguments:'{}'}])
})

it('keeps a null final answer strict and avoids replaying an already sealed answer', async () => {
  let calls = 0
  const seen: string[] = []
  const model = new OpenAIChatDriver('purpose-tool-final-fixture',{apiKey:'synthetic',maxAttempts:1,publicTextProtocol:'purpose-json-v3',
    fetchImpl:async(_url,init)=>{
      calls++
      const body=JSON.parse(String(init?.body))
      assert.ok(body.messages[0].content.includes(sealedFinalExample))
      assert.deepEqual(body.response_format,{type:'json_object'})
      return new Response(frame({content:JSON.stringify({operation,commentary:'',answer:null,outcome:final})},'stop')+'data: [DONE]\n\n')
    }})
  const request={instructions:'Finish the known sources.',items:[],tools:[],codeExecution:'disabled' as const,onTextDelta:(text:string)=>{seen.push(text)}}
  await assert.rejects(model.run(request),error=>error instanceof ModelDriverError&&error.diagnostics.protocolCode==='public_text_answer_required')
  const result=await model.run({...request,answerContext:{messageId:'answer-fixture',segmentIds:['sealed-source']}})
  assert.equal(calls,2)
  assert.equal(result.answerIsNull,true)
  assert.deepEqual(result.output,[])
  assert.deepEqual(result.outcomeDeclaration,final)
  assert.deepEqual(seen,[])
})

it('preserves legacy instruction text',()=>{
  for(const profile of [undefined,{parallelTools:false,jsonObjectWithTools:false},{parallelTools:true,jsonObjectWithTools:true}]) {
    assert.equal(publicPurposeInstructions('purpose-json-v2',profile),PUBLIC_PURPOSE_V2_INSTRUCTIONS)
  }
})

it('versions only the changed v3 prompt policy and preserves clone and legacy binding identity',()=>{
  const options={apiKey:'synthetic',maxThinkingTokens:0,capabilities:{jsonObjectWithTools:false,parallelTools:false}}
  for(const [publicTextProtocol,fingerprint,tokens] of [
    ['purpose-json-v2','c5a3ffc2915dc602de0ed90fb8a6ad754c4b61a2c864b0c3a17c11a7ed1de77c',1596],
  ] as const){
    const model=new OpenAIChatDriver('purpose-tool-turn-fixture',{...options,publicTextProtocol})
    assert.equal(model.configurationFingerprint,fingerprint)
    assert.equal(model.protocolTokens,tokens)
    assert.equal(model.singleAttempt().configurationFingerprint,fingerprint)
  }
  const model=new OpenAIChatDriver('purpose-tool-turn-fixture',{...options,publicTextProtocol:'purpose-json-v3'})
  assert.notEqual(model.configurationFingerprint,'1c286a7bc4a749394251e4e3c8ff9e0b22bddad34996687e008afeb963018b90')
  assert.equal(model.singleAttempt().configurationFingerprint,model.configurationFingerprint)
  assert.equal(model.protocolTokens,model.countTokens(publicPurposeInstructions('purpose-json-v3',options.capabilities)))
})
