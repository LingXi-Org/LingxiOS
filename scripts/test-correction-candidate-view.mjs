import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createRunView,publicAnswerSegments} from '../dist/src/ui/index.js'
import {answerCorrectionOperation,restoreAnswerCorrection,assertAnswerCorrection} from '../dist/src/runtime/answer-correction.js'
const part=(id,text,seq,{supersedes=[],segmentId=id,reason=null,sealed=false}={})=>({version:3,purpose:'answer',messageId:'answer:run:v1',segmentId,partId:id,requestVersion:1,fence:1,attemptId:id,partIndex:1,operation:supersedes.length?'replace':'append',supersedes,text,firstSeq:seq,lastSeq:seq+1,endedSeq:reason?seq+1:null,reason,status:reason==='failed'?'incomplete':reason?'complete':'running',...(sealed?{sealedSeq:seq+2,bodyHash:'a'.repeat(64)}:{})})
const view=parts=>({...createRunView('run'),requestVersion:1,fence:1,publicTextParts:parts})
const visible=parts=>publicAnswerSegments(view(parts)).filter(x=>!['replaced','pending-replacement'].includes(x.status))
test('failed append corrections occupy one logical slot while preserving valid prefix',()=>{
 const p=part('P','Prefix. ',1,{reason:'tool',sealed:true}),f=part('F','bad',5,{reason:'failed'}),r=part('R','Corrected.',9,{supersedes:['F'],segmentId:'F'})
 assert.deepEqual(visible([p,f,r]).map(x=>[x.partId,x.text,x.status]),[['P','Prefix. ','sealed'],['R','Corrected.','streaming']])
 assert.equal(publicAnswerSegments(view([p,f,r])).find(x=>x.partId==='F').status,'replaced')
})
test('failed correction chain never reintroduces earlier drafts on replay',()=>{
 const f=part('F','bad',1,{reason:'failed'}),r1=part('R1','also bad',5,{supersedes:['F'],segmentId:'F',reason:'failed'}),r2=part('R2','Valid.',9,{supersedes:['R1'],segmentId:'F',reason:'completed',sealed:true})
 assert.deepEqual(visible([f,r1,r2]).map(x=>[x.partId,x.text]),[['R2','Valid.']])
 assert.equal(visible([f,r1,r2])[0].status,'sealed','seal is not final acceptance')
})
test('failed replacement of sealed sources keeps valid originals until accepted commit',()=>{
 const s=part('S','Kept.',1,{reason:'tool',sealed:true}),f=part('F','bad',5,{supersedes:['S'],segmentId:'S',reason:'failed'}),r=part('R','Candidate.',9,{supersedes:['F'],segmentId:'S'})
 assert.deepEqual(visible([s,f,r]).map(x=>x.partId),['S'])
 assert.equal(publicAnswerSegments(view([s,f,r])).find(x=>x.partId==='R').status,'pending-replacement')
})
test('unknown, nonfailed, future or mismatched replacement targets cannot open a draft slot',()=>{
 const s=part('S','Kept.',1,{reason:'tool',sealed:true})
 for(const r of [part('R','Bad',5,{supersedes:['unknown']}),part('R','Bad',5,{supersedes:['S'],segmentId:'S'}),part('R','Bad',0,{supersedes:['F'],segmentId:'F'}),part('R','Bad',5,{supersedes:['F'],segmentId:'wrong'})]){
  const f=part('F','failed',2,{reason:'failed'})
  assert.equal(visible([s,f,r]).some(x=>x.partId==='R'),false)
 }
})
test('correction intent restores exact failed target and rejects append before new bytes',()=>{
 const op=answerCorrectionOperation(true,['F']),step={kind:'runtime.answer_correction',requestVersion:1,input:{operation:op}}
 assert.deepEqual(restoreAnswerCorrection([step],1,['F']),op)
 assert.deepEqual(restoreAnswerCorrection([],1,['F'],['P']),op,'failed end restores repair even before correction intent was saved')
 assert.equal(restoreAnswerCorrection([step],1,['R']),undefined)
 assert.throws(()=>assertAnswerCorrection({kind:'append',supersedes:[]},op))
 assert.doesNotThrow(()=>assertAnswerCorrection({kind:'replace',supersedes:['F']},op))
})

test('final commit verifies failed lineage but never accepts the failed candidate itself',async()=>{
 const {verifySealedAnswerSources}=await import('../dist/src/app/answer-sources.js')
 const {AnswerSegmentSet}=await import('../dist/src/runtime/answer-segments.js')
 const {createHash}=await import('node:crypto'),hash=text=>createHash('sha256').update(text).digest('hex')
 const identity=(id,op={kind:'append',supersedes:[]},segmentId=id)=>({version:3,purpose:'answer',messageId:'answer:run:v1',segmentId,partId:id,requestVersion:1,fence:1,attemptId:id,partIndex:1,operation:op.kind,supersedes:op.supersedes})
 const p=identity('P'),f=identity('F'),r=identity('R',{kind:'replace',supersedes:['F']},'F')
 const set=new AnswerSegmentSet('run',1,1)
 set.seal({identity:p,text:'Prefix. ',bodyHash:hash('Prefix. ')});set.fail(f);set.seal({identity:r,text:'Fixed.',bodyHash:hash('Fixed.')})
 const assembled=set.assemble()
 const row=(kind,input,output)=>({kind,request_version:1,step_id:input.partId??'candidate',input,output,artifacts:[]})
 const rows=[row('runtime.answer_segment',{...p,bodyHash:hash('Prefix. ')},JSON.stringify({text:'Prefix. '})),row('runtime.answer_candidate_failure',{...f,endedSeq:5},'{}'),row('runtime.answer_segment',{...r,bodyHash:hash('Fixed.')},JSON.stringify({text:'Fixed.'})),row('runtime.candidate',{publicTextSources:assembled.sources},'{}')]
 const db={async query(sql){assert.match(sql,/runtime.answer_candidate_failure/);return {rows}}}
 const work={id:'run',fence:1},message={body:assembled.body,publicTextSources:assembled.sources,envelope:{requestVersion:1,goalOutcome:{status:'satisfied'}}}
 await verifySealedAnswerSources(db,work,message)
 const invalid={...assembled.sources,segments:assembled.sources.segments.map(s=>s.partId==='R'?{...s,partId:'F'}:s)}
 await assert.rejects(verifySealedAnswerSources(db,work,{...message,publicTextSources:invalid}),/not sealed/)
})
