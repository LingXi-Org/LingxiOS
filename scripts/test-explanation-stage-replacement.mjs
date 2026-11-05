// Focused recovery-reader regression; no model, database or external service.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { createExplanationStage,readExplanationStage,explanationStageTools,explanationStageInstructions } from '../dist/src/skills/explanation-stage.js'
import { skillIndex } from '../dist/src/skills/definition.js'
const hash=text=>createHash('sha256').update(text).digest('hex')
const work={id:'run',tenantId:'tenant',principalId:'human',fence:1}
const request={workId:'run',tenantId:'tenant',authorId:'human',sourceRef:'request',originalText:'Explain facts then create. Gather collects items.',revisions:[]}
const skill={name:'diagram',version:'1',description:'Create a diagram.',body:'Use the authorized save tool.',actions:['documents.save'],delivery:{checker:'product:diagram'},workflow:{explanationBeforeAuthoring:{authoringActions:['documents.save']}}}
const index=skillIndex(skill),activationId=hash('activation')
const stage=createExplanationStage(work,request,activationId,skill.workflow.explanationBeforeAuthoring.authoringActions,
  {explanationQuote:'Explain facts',authoringQuote:'create',factQuotes:['Gather collects items.']},index)
const tools=[{name:'documents__save',action:'documents.save'},{name:'documents__read',action:'documents.read'}]
function row(partId,text,operation={kind:'append',supersedes:[]},stageId,segmentId=partId){
  const recovery={version:2,phase:'intermediate',memorySources:[],publicAnswerCall:{type:'function_call',callId:partId,name:'public_answer',arguments:JSON.stringify({operation,answer:text,outcome:null})},...(stageId?{explanationStageId:stageId}:{})}
  return {kind:'runtime.answer_segment',input:{version:3,purpose:'answer',messageId:'answer:run:v1',segmentId,partId,requestVersion:1,fence:1,attemptId:partId,partIndex:1,operation:operation.kind,supersedes:operation.supersedes,bodyHash:hash(text)},output:JSON.stringify({text,recovery})}
}
function database(rows,recordedStage=stage){return {async query(sql){
  if(sql.includes('agent_action_intents'))return {rows:[{skill_name:skill.name,skill_version:skill.version,skill_hash:index.hash,id:activationId,stage:recordedStage}]}
  if(sql.includes('agent_request_snapshots'))return {rows:[{request_snapshot:request}]}
  if(sql.includes('agent_steps'))return {rows}
  assert.fail('unexpected query')
}}}
const before=row('before','Earlier unbound explanation. ')
const replacement=row('corrected','Gather collects items. ',{kind:'replace',supersedes:['before']},stage.id,'before')

test('only a sealed replacement bound to the pending current stage restores authoring',async()=>{
  const pending=await readExplanationStage(database([before]),work,1,[skill])
  assert.equal(pending.status,'pending');assert.deepEqual((await explanationStageTools(tools,pending)).map(t=>t.action),['documents.read'])
  const provided=await readExplanationStage(database([before,replacement]),work,1,[skill])
  assert.equal(provided.status,'provided');assert.equal(provided.provided.partId,'corrected')
  assert.deepEqual(await explanationStageTools(tools,provided),tools)
  assert.match(explanationStageInstructions(provided),/the explanation is durably recorded/)
  assert.match(explanationStageInstructions(provided),/instead of saving again/)
})

test('unbound and foreign-stage replacements do not restore authoring',async()=>{
  for(const stageId of [undefined,hash('foreign')]){
    const unrelated=row('corrected','Gather collects items. ',{kind:'replace',supersedes:['before']},stageId,'before')
    assert.equal((await readExplanationStage(database([before,unrelated]),work,1,[skill])).status,'pending')
  }
})

test('superseding the provided source with an unbound replacement removes stage proof',async()=>{
  const newer=row('newer','Different unbound text. ',{kind:'replace',supersedes:['corrected']},undefined,'before')
  assert.equal((await readExplanationStage(database([before,replacement,newer]),work,1,[skill])).status,'pending')
})

test('invalid target, body hash and changed request bindings remain rejected',async()=>{
  await assert.rejects(readExplanationStage(database([before,row('wrong','Explanation.',{kind:'replace',supersedes:['foreign']},stage.id,'before')]),work,1,[skill]))
  await assert.rejects(readExplanationStage(database([before,{...replacement,input:{...replacement.input,bodyHash:hash('wrong')}}]),work,1,[skill]))
  await assert.rejects(readExplanationStage(database([before,replacement],{...stage,requestHash:hash('changed')}),work,1,[skill]))
})
