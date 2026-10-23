import assert from 'node:assert/strict'
import { it } from 'node:test'
import { PublicPurposeParser } from '../src/model/public-purpose.js'

const protocol = 'purpose-json-v3' as never
const wire = (answer: string | null, operation = {kind:'append',supersedes:[] as string[]}) =>
  JSON.stringify({operation,commentary:'Checking a record.',answer,outcome:{status:'satisfied',gaps:[]}})

it('v3 declares operation before streaming answer and retains null final declaration', () => {
  for (const answer of ['Useful A', null]) {
    const parser = new PublicPurposeParser(protocol)
    const parts = []
    for (const character of wire(answer)) parts.push(...parser.push(character))
    parser.finish()
    assert.deepEqual(Reflect.get(parser,'operation'),{kind:'append',supersedes:[]})
    assert.equal(parts.filter(part=>part.purpose==='answer').map(part=>part.text).join(''),answer??'')
    assert.deepEqual(parser.outcome,{status:'satisfied',gaps:[]})
    assert.equal(Reflect.get(parser,'answerIsNull'),answer===null)
  }
})

it('v3 rejects duplicate metadata and keeps v2 strict', () => {
  for (const invalid of [
    wire('A').replace('"kind":"append"','"kind":"append","kind":"replace"'),
    wire('A',{kind:'append',supersedes:['old']}),
    wire('A',{kind:'replace',supersedes:[]}),
    wire('A',{kind:'replace',supersedes:['old','old']}),
    wire('A').replace('"operation":','"unknown":'),
  ]) assert.throws(()=>{const parser=new PublicPurposeParser(protocol);parser.push(invalid);parser.finish()})
  assert.throws(()=>new PublicPurposeParser('purpose-json-v2').push(wire('A')))
})
