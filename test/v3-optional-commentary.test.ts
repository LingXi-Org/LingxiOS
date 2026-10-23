import assert from 'node:assert/strict'
import {it} from 'node:test'
import {PublicPurposeParser} from '../src/model/public-purpose.js'
import {OpenAIChatDriver} from '../src/model/openai.js'
const prefix='{"operation":{"kind":"append","supersedes":[]},"answer":"'
const operation={kind:'append',supersedes:[] as string[]}
const terminal={status:'satisfied',gaps:[]}
const wire=(answer:string|null,outcome:unknown=terminal,op=operation)=>JSON.stringify({operation:op,answer,outcome})

it('the observed operation→answer prefix streams typed text before outcome completion',()=>{
  const parser=new PublicPurposeParser('purpose-json-v3'),parts:ReturnType<PublicPurposeParser['push']>=[]
  for(const character of prefix)parts.push(...parser.push(character))
  assert.deepEqual(parser.operation,operation);assert.equal(parts.length,0)
  for(const character of 'Known fact. ')parts.push(...parser.push(character))
  assert.equal(parts.map(p=>p.text).join(''),'Known fact. ')
  assert.ok(parts.every(p=>p.purpose==='answer'));assert.equal(parser.complete,false)
  parser.push('","outcome":null}');parser.finish();assert.equal(parser.outcome,null)
})
it('omission uses existing answer/null/replace and Unicode streaming states at every split',()=>{
  for(const answer of ['中😀\nquoted "value"',null])for(const outcome of [terminal,null])for(const op of [operation,{kind:'replace',supersedes:['sealed-part']}]){
    const text=wire(answer,outcome,op)
    for(let split=0;split<=text.length;split++){
      const parser=new PublicPurposeParser('purpose-json-v3')
      const parts=[...parser.push(text.slice(0,split)),...parser.push(text.slice(split))];parser.finish()
      assert.equal(parts.filter(p=>p.purpose==='answer').map(p=>p.text).join(''),answer??'')
      assert.deepEqual(parser.operation,op);assert.deepEqual(parser.outcome,outcome);assert.equal(parser.answerIsNull,answer===null)
    }
  }
})
it('explicit commentary is not promoted and omitted commentary is equivalent to empty commentary',()=>{
  for(const commentary of ['', 'Public status.']){
    const parser=new PublicPurposeParser('purpose-json-v3')
    const parts=parser.push(JSON.stringify({operation,commentary,answer:'Useful answer.',outcome:terminal}));parser.finish()
    assert.equal(parts.filter(p=>p.purpose==='answer').map(p=>p.text).join(''),'Useful answer.')
    assert.equal(parts.filter(p=>p.purpose==='commentary').map(p=>p.text).join(''),commentary)
  }
})
it('omission does not weaken ordering, unknown/duplicate keys, typed values or completion',()=>{
  const valid=wire('Useful answer.')
  for(const text of [
    '{"answer":"Useful answer.","operation":{"kind":"append","supersedes":[]},"outcome":null}',
    '{"answer":"Useful answer.","outcome":null}',
    valid.replace('"answer":','"reasoning":'),
    valid.replace('"answer":','"unknown":false,"answer":'),
    valid.replace('"answer":','"commentary":null,"answer":'),
    valid.replace('"answer":','"commentary":"","commentary":"","answer":'),
    valid.replace('"outcome":','"answer":"Duplicate","outcome":'),
    valid.replace('"outcome":','"commentary":"late","outcome":'),
    valid.replace('"answer":"Useful answer."','"answer":true'),
    valid.replace('"answer":','"operation":{"kind":"append","supersedes":[]},"answer":'),
    valid.slice(0,-1),prefix,prefix+'Unclosed',valid+' trailing',
  ])assert.throws(()=>{const parser=new PublicPurposeParser('purpose-json-v3');parser.push(text);parser.finish()})
})
it('v1/v2 still require commentary and keep the prior configuration fingerprints',()=>{
  const fingerprints={
    'purpose-json-v1':'a36987763fcb884c00f01bae0ceeb572c4b569b6bfbae351925d81b44873e984',
    'purpose-json-v2':'52d8757d54a17fa4bc53097f15aa5d477f8c8134af29c9d21bba8b0c9d34ea05',
  } as const
  for(const protocol of ['purpose-json-v1','purpose-json-v2'] as const){
    assert.throws(()=>{const parser=new PublicPurposeParser(protocol);parser.push('{"answer":"43"'+(protocol==='purpose-json-v2'?',"outcome":{"status":"satisfied","gaps":[]}':'')+'}');parser.finish()})
    const driver=new OpenAIChatDriver('optional-commentary-fixture',{apiKey:'synthetic',publicTextProtocol:protocol,maxAttempts:1,capabilities:{parallelTools:false,jsonObjectWithTools:false}})
    assert.equal(driver.configurationFingerprint,fingerprints[protocol])
  }
})
it('v3 parsing-policy change has a distinct replay fingerprint',()=>{
  const driver=new OpenAIChatDriver('optional-commentary-fixture',{apiKey:'synthetic',publicTextProtocol:'purpose-json-v3',maxAttempts:1,capabilities:{parallelTools:false,jsonObjectWithTools:false}})
  assert.notEqual(driver.configurationFingerprint,'785f7e7bef32a6ebac0b61e4c2e4abcd63287d6bc7211195bd56ab3740b65f2f')
})
it('driver retains intermediate and terminal semantics for omitted commentary without another request',async()=>{
  for(const intermediate of [false,true]){
    let calls=0;const seen:string[]=[]
    const driver=new OpenAIChatDriver('optional-driver',{apiKey:'synthetic',maxAttempts:1,publicTextProtocol:'purpose-json-v3',publicTextContinuation:'typed-message-v1',fetchImpl:async()=>{
      calls++;const content=wire(intermediate?'Known fact.':'43',intermediate?null:terminal)
      return new Response(`data: ${JSON.stringify({choices:[{delta:{content},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)
    }})
    const result=await driver.run({instructions:'Synthetic only.',items:[],codeExecution:'disabled',onTextDelta:d=>{seen.push(d)}})
    assert.equal(result.publicTextPhase,intermediate?'intermediate':undefined)
    assert.equal(result.text,seen.join(''));assert.equal(calls,1)
    assert.deepEqual(result.outcomeDeclaration,intermediate?undefined:terminal)
  }
})
