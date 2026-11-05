// Owning #579 regression. Run after npm run build; no provider or external service.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { AnswerSegmentSet } from '../dist/src/runtime/answer-segments.js'
import { publicTextPublication } from '../dist/src/app/public-text.js'
const hash=text=>createHash('sha256').update(text).digest('hex')
const append={kind:'append',supersedes:[]}
const replace=(...supersedes)=>({kind:'replace',supersedes})
function identity(id,operation=append,segmentId=id,fence=1){return {version:3,purpose:'answer',requestVersion:1,fence,attemptId:id,partId:id,partIndex:1,messageId:'answer:run:v1',segmentId,operation:operation.kind,supersedes:operation.supersedes}}
function seal(set,id,text,operation=append,segmentId=id,fence=1){const record={identity:identity(id,operation,segmentId,fence),text,bodyHash:hash(text)};set.seal(record);return record}
const failedStep=(source,seq)=>({id:`failed:${source.partId}`,kind:'runtime.answer_candidate_failure',requestVersion:1,input:{...source,endedSeq:seq},output:'{}',artifacts:[]})
const sealedStep=record=>({id:`sealed:${record.identity.partId}`,kind:'runtime.answer_segment',requestVersion:1,input:{...record.identity,bodyHash:record.bodyHash},output:JSON.stringify({text:record.text}),artifacts:[]})

test('failed append correction adds only its replacement and preserves the sealed prefix',()=>{
  const set=new AnswerSegmentSet('run',1,1)
  seal(set,'prefix','Known prefix. ')
  set.fail(identity('failed'))
  assert.deepEqual(set.correctionSources,['failed']);assert.deepEqual(set.context.segmentIds,['prefix'])
  assert.equal(set.prepare(replace('failed'),'corrected'),'failed')
  seal(set,'corrected','Corrected tail.',replace('failed'),'failed')
  assert.equal(set.assemble().body,'Known prefix. Corrected tail.')
  assert.deepEqual(set.records.map(r=>r.identity.partId),['prefix','corrected'])
  assert.deepEqual(set.correctionSources,['prefix','corrected'])
  assert.throws(()=>set.prepare(replace('failed'),'stale'))
})

test('failed sealed-source replacement retains its original targets across another failed correction and restart',()=>{
  const set=new AnswerSegmentSet('run',1,2)
  const prefix=seal(set,'prefix','Unaffected. '),one=seal(set,'one','Old one. '),two=seal(set,'two','Old two.')
  const failed=identity('failed',replace('one','two'),'one'),again=identity('again',replace('failed'),'one')
  set.fail(failed);set.fail(again)
  assert.equal(set.assemble().body,'Unaffected. Old one. Old two.')
  const steps=[sealedStep(prefix),sealedStep(one),sealedStep(two),failedStep(failed,11),failedStep(again,14)]
  const restored=new AnswerSegmentSet('run',1,2,steps)
  assert.deepEqual(restored.correctionSources,['again']);assert.equal(restored.prepare(replace('again'),'fixed'),'one')
  const fixed=seal(restored,'fixed','Corrected.',replace('again'),'one',2)
  assert.equal(restored.assemble().body,'Unaffected. Corrected.')
  const after=new AnswerSegmentSet('run',1,3,[...steps,sealedStep(fixed)])
  assert.equal(after.assemble().body,restored.assemble().body)
  assert.deepEqual(after.records.map(r=>r.identity.partId),['prefix','fixed'])
})

test('failed append lineage never supplies sealed history or permits an empty assembled answer',()=>{
  const set=new AnswerSegmentSet('run',1,2)
  const failed=identity('failed'),again=identity('again',replace('failed'),'failed',2)
  set.fail(failed);set.fail(again)
  assert.equal(set.hasBody,false);assert.deepEqual(set.records,[]);assert.deepEqual(set.context.segmentIds,[])
  assert.deepEqual(set.correctionSources,['again']);assert.throws(()=>set.assemble())
  const session={request:{workId:'run',revisions:[]},history:[]}
  assert.equal(set.restoreMessageHistory(session,'run'),false);assert.deepEqual(session.history,[])
  const restored=new AnswerSegmentSet('run',1,2,[failedStep(failed,3),failedStep(again,100003)])
  seal(restored,'fixed','Only valid body.',replace('again'),'failed',2)
  assert.deepEqual(restored.assemble().sources.segments.map(s=>s.partId),['fixed'])
})

test('failed identities are immutable, bounded to this request/fence, and cannot be promoted to seals',()=>{
  const set=new AnswerSegmentSet('run',1,2),failed=identity('failed')
  set.fail(failed);set.fail(structuredClone(failed))
  assert.throws(()=>set.fail({...failed,attemptId:'changed'}))
  assert.throws(()=>seal(set,'failed','Cannot promote.'))
  for(const patch of [{messageId:'answer:other:v1'},{requestVersion:2},{fence:3},{fence:0},{segmentId:'wrong'},{attemptId:''}])
    assert.throws(()=>new AnswerSegmentSet('run',1,2).fail({...failed,...patch}))
  assert.throws(()=>set.prepare(replace('missing'),'new'))
  assert.throws(()=>set.prepare(replace('failed','missing'),'new'))
  assert.throws(()=>set.fail(identity('wrong-slot',replace('failed'),'wrong')))
  const sealed=new AnswerSegmentSet('run',1,2);seal(sealed,'existing','Existing.')
  assert.throws(()=>sealed.fail(identity('existing')))
  assert.throws(()=>set.fail(identity('future-child',replace('failed'),'failed',0)))
})

function transactionFixture({rejectStep=false,stale=false,duplicate=false,reason='failed'}={}){
  const committed={events:[],steps:[]};let tx;const calls=[]
  const prior={...identity('failed'),chunkIndex:0,text:'PRIVATE_FAILED_TEXT'}
  const row={id:'run',fence:1,tenant_id:'tenant',agent_id:'agent',session_id:'session',kind:'turn',lane:'foreground',trigger_ref:'request',
    principal_id:'human',thread_id:null,created_at:new Date(0),available_at:new Date(0),attempts:1,steer_inputs:[],request_version:1}
  const client={release(){},async query(sql,params=[]){
    calls.push(sql)
    if(sql==='BEGIN'){tx={events:[],steps:[]};return {rows:[]}}
    if(sql==='COMMIT'){committed.events.push(...tx.events);committed.steps.push(...tx.steps);return {rows:[]}}
    if(sql==='ROLLBACK'){tx=undefined;return {rows:[]}}
    if(sql.includes('FROM pg_settings'))return {rows:[{name:'statement_timeout',setting:'0'},{name:'client_connection_check_interval',setting:'0'}]}
    if(sql.includes('set_config'))return {rows:[]}
    if(sql.includes('FROM lingxios.agent_work_items'))return {rows:stale?[]:[row]}
    if(sql.includes('SELECT kind,stage,visibility,data'))return {rows:duplicate?[event]:[]}
    if(sql.includes('ORDER BY seq DESC LIMIT 1'))return {rows:[{kind:'public.text.delta',data:prior}]}
    if(sql.includes('INSERT INTO lingxios.agent_steps')){
      if(rejectStep)throw new Error('synthetic step rejection')
      tx.steps.push({sql,params});return {rows:[],rowCount:1}
    }
    assert.fail(`Unexpected query: ${sql}`)
  }}
  const pool={...client,async connect(){return client}}
  const publication=publicTextPublication(pool,async()=>true)
  const event={runId:'run',seq:3,kind:'public.text.ended',stage:'completed',visibility:'user',data:{...identity('failed'),chunkCount:1,reason}}
  const publish=()=>publication.append(event,{workId:'run',fence:1,leaseTokenHash:'synthetic'},row,async db=>{assert.notEqual(db,pool);tx.events.push(event);return true})
  return {committed,calls,publish}
}

test('failed publication commits only candidate identity metadata with the ended event',async()=>{
  const f=transactionFixture();assert.equal(await f.publish(),true)
  assert.equal(f.committed.events.length,1);assert.equal(f.committed.steps.length,1)
  const step=f.committed.steps[0]
  assert.match(step.sql,/runtime.answer_candidate_failure/)
  assert.equal(JSON.stringify(step.params).includes('PRIVATE_FAILED_TEXT'),false)
  const input=JSON.parse(step.params[4]);assert.equal(input.endedSeq,3);assert.equal(input.partId,'failed')
  assert.equal('text' in input,false);assert.equal('bodyHash' in input,false);assert.equal('sealedSeq' in input,false)
})

test('candidate metadata failure rolls back the ended event and a stale lease writes neither',async()=>{
  const rejected=transactionFixture({rejectStep:true});await assert.rejects(rejected.publish(),/synthetic step rejection/)
  assert.deepEqual(rejected.committed,{events:[],steps:[]});assert.ok(rejected.calls.includes('ROLLBACK'))
  const stale=transactionFixture({stale:true});await assert.rejects(stale.publish(),/lease/);assert.deepEqual(stale.committed,{events:[],steps:[]})
})


test('changed active sources invalidate failed targets and recovery validates the recorded fence',()=>{
  const set=new AnswerSegmentSet('run',1,2),first=seal(set,'first','Known. ')
  const failed=identity('failed');set.fail(failed)
  seal(set,'later','Later.')
  assert.deepEqual(set.correctionSources,['first','later'])
  assert.throws(()=>set.prepare(replace('failed'),'stale'))
  assert.throws(()=>new AnswerSegmentSet('run',1,2,[sealedStep(first),failedStep(failed,100001)]),/recovery/)
  assert.throws(()=>new AnswerSegmentSet('run',1,2).fail(identity('self',replace('self'),'self')))
})

test('completed or cancelled ends and exact event replay do not create failed source metadata',async()=>{
  for(const reason of ['completed','cancelled']){
    const f=transactionFixture({reason});assert.equal(await f.publish(),true)
    assert.equal(f.committed.events.length,1);assert.equal(f.committed.steps.length,0)
  }
  const replay=transactionFixture({duplicate:true});assert.equal(await replay.publish(),false)
  assert.deepEqual(replay.committed,{events:[],steps:[]})
})
