import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import * as ui from '../src/ui/index.js'
import { answerMessageId, assemblePublicTextSources } from '../src/protocol/answer-segments.js'
import type { AssistantMessage, RunEvent } from '../src/protocol/types.js'
import type { PublicTextIdentity } from '../src/protocol/public-text.js'

const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
const identity=(partId:string,extra:Partial<PublicTextIdentity>={}):PublicTextIdentity=>({version:3,purpose:'answer',requestVersion:1,fence:1,
  attemptId:'attempt-1',partId,partIndex:0,messageId:answerMessageId('run',1),segmentId:partId,operation:'append',supersedes:[],...extra})
const event=(seq:number,kind:string,id:PublicTextIdentity,data:Record<string,unknown>={}):RunEvent=>({runId:'run',seq,kind,stage:kind==='public.text.delta'?'delta':'completed',visibility:'user',data:{...id,...data}})
function fixture(){let view=ui.createRunView('run'),seq=0;return {get view(){return view},set view(value:ui.RunView){view=value},
  emit(kind:string,id:PublicTextIdentity,data:Record<string,unknown>={}){const before=JSON.stringify(view);try{view=ui.consumeRunEvent(view,event(++seq,kind,id,data))}catch(error){assert.equal(JSON.stringify(view),before);throw error}return view},
  seal(id:PublicTextIdentity,text:string){this.emit('public.text.operation',id);this.emit('public.text.delta',id,{chunkIndex:0,text});this.emit('public.text.ended',id,{chunkCount:1,reason:'tool'});this.emit('public.text.sealed',id,{chunkCount:1,bodyHash:sha(text)})},
  commit(sources:unknown){view=ui.consumeRunEvent(view,{runId:'run',seq:++seq,kind:'response.committed',stage:'completed',visibility:'user',data:{resultId:'result',requestVersion:1,publicTextSources:sources}})}}}
type Segment={messageId:string;segmentId:string;partId:string;text:string;status:string;operation:string;start:number;end:number;requestVersion:number;fence:number;bodyHash?:string}
const segments=(view:ui.RunView):Segment[]=>{const fn=Reflect.get(ui,'publicAnswerSegments') as ((view:ui.RunView)=>Segment[])|undefined;assert.equal(typeof fn,'function');return fn!(view)}
const active=(view:ui.RunView)=>segments(view).filter(s=>!['pending-replacement','replaced'].includes(s.status))
const sources=(rows:Array<{id:PublicTextIdentity;text:string}>)=>assemblePublicTextSources(answerMessageId('run',1),rows.map(({id,text})=>({segmentId:id.segmentId!,partId:id.partId,text,bodyHash:sha(text)})),sha(rows.map(r=>r.text).join('').trim()))
function message(body:string,publicTextSources:AssistantMessage['publicTextSources']):AssistantMessage{return {version:2,runId:'run',agentId:'agent',sessionId:'session',body,...(publicTextSources?{publicTextSources}:{}),
  envelope:{version:1,evidenceSnapshotId:'evidence',body,requestVersion:1,goalOutcome:{status:'satisfied',verification:'inconclusive',requestVersion:1},citations:[],artifacts:[]}}}

test('v3 archives explicit operation and sealed append identities without text or attempt deduplication',()=>{
  const f=fixture();f.seal(identity('a'),'same');f.seal(identity('b',{attemptId:'attempt-2',partIndex:1}),'same')
  assert.deepEqual(active(f.view).map(s=>[s.segmentId,s.partId,s.text,s.status,s.start,s.end]),[['a','a','same','sealed',0,4],['b','b','same','sealed',4,8]])
  assert.equal(f.view.message,null);assert.equal(f.view.publicTextParts?.every(p=>p.acceptedResultId===null),true)
})
test('live ranges concatenate exactly then outer-trim once, including UTF16 emoji offsets',()=>{
  const f=fixture();f.seal(identity('a'),'  A🙂 ');f.emit('public.text.operation',identity('b'));f.emit('public.text.delta',identity('b'),{chunkIndex:0,text:' B  '})
  assert.deepEqual(active(f.view).map(s=>[s.text,s.start,s.end,s.status]),[['A🙂 ',0,4,'sealed'],[' B',4,6,'streaming']])
})
test('pending and failed replacement preserve old text and stay out of the normal answer',()=>{
  const f=fixture();f.seal(identity('a'),'old');const replacement=identity('a-r2',{segmentId:'a',operation:'replace',supersedes:['a']})
  f.emit('public.text.operation',replacement);f.emit('public.text.delta',replacement,{chunkIndex:0,text:'new'});f.emit('public.text.ended',replacement,{chunkCount:1,reason:'failed'})
  assert.deepEqual(active(f.view).map(s=>s.text),['old']);assert.deepEqual(segments(f.view).map(s=>[s.partId,s.status]),[['a','sealed'],['a-r2','pending-replacement']])
})
test('sealed replacement activates atomically only when an authoritative ordered collection commits',()=>{
  const f=fixture(),a=identity('a'),b=identity('b'),r=identity('a-r2',{segmentId:'a',operation:'replace',supersedes:['a']})
  f.seal(a,'old ');f.seal(b,'tail');f.seal(r,'new ')
  assert.deepEqual(active(f.view).map(s=>s.text),['old ','tail'])
  const final=sources([{id:r,text:'new '},{id:b,text:'tail'}]);f.commit(final.sources)
  assert.deepEqual(active(f.view).map(s=>[s.segmentId,s.partId,s.text,s.status]),[['a','a-r2','new ','accepted'],['b','b','tail','accepted']])
  assert.equal(segments(f.view).find(s=>s.partId==='a')?.status,'replaced')
  const before=JSON.stringify(f.view);assert.equal(ui.consumeRunEvent(f.view,event(2,'public.text.delta',a,{chunkIndex:0,text:'old '})),f.view);assert.equal(JSON.stringify(f.view),before)
})
test('message-first reconstructs final source ranges and later event replay does not duplicate them',()=>{
  const a=identity('a'),b=identity('b'),final=sources([{id:a,text:' A🙂 '},{id:b,text:' B '}]),f=fixture()
  f.view=ui.consumeAssistantMessage(f.view,message(final.body,final.sources),{resultId:'result',fence:1})
  assert.deepEqual(active(f.view).map(s=>[s.partId,s.text,s.start,s.end]),[['a','A🙂 ',0,4],['b',' B',4,6]])
  f.seal(a,' A🙂 ');f.seal(b,' B ')
  assert.equal(active(f.view).length,2);assert.equal(f.view.publicTextParts?.every(p=>p.acceptedResultId==='result'),true)
})
test('bad ordering, identity or seal rejects without changing the prior view',()=>{
  const id=identity('a')
  const cases:Array<(f:ReturnType<typeof fixture>)=>void>=[
    f=>f.emit('public.text.delta',id,{chunkIndex:0,text:'a'}),
    f=>{f.emit('public.text.operation',id);f.emit('public.text.operation',id)},
    f=>{f.emit('public.text.operation',id);f.emit('public.text.delta',id,{chunkIndex:1,text:'a'})},
    f=>{f.emit('public.text.operation',id);f.emit('public.text.delta',{...id,segmentId:'other'},{chunkIndex:0,text:'a'})},
    f=>{f.emit('public.text.operation',id);f.emit('public.text.delta',id,{chunkIndex:0,text:'a'});f.emit('public.text.sealed',id,{chunkCount:1,bodyHash:sha('a')})},
    f=>{f.emit('public.text.operation',id);f.emit('public.text.delta',id,{chunkIndex:0,text:'a'});f.emit('public.text.ended',id,{chunkCount:1,reason:'failed'});f.emit('public.text.sealed',id,{chunkCount:1,bodyHash:sha('a')})},
    f=>{f.seal(id,'a');f.emit('public.text.delta',id,{chunkIndex:1,text:'b'})},
    f=>{f.seal(id,'a');f.emit('public.text.sealed',id,{chunkCount:1,bodyHash:sha('a')})}
  ]
  for(const run of cases){const f=fixture();assert.throws(()=>run(f))}
})
test('final sources reject cross-request, wrong seal and invalid ranges without erasing old text',()=>{
  const changes:Array<(s:ReturnType<typeof sources>['sources'])=>void>=[s=>{s.messageId=answerMessageId('run',2)},s=>{s.segments[0]!.bodyHash=sha('wrong')},s=>{s.segments[0]!.start=1},s=>{s.segments[0]!.end=99}]
  for(const change of changes){
    const f=fixture(),id=identity('a');f.seal(id,'old');const final=sources([{id,text:'old'}]);change(final.sources);const before=JSON.stringify(f.view)
    assert.throws(()=>{f.view=ui.consumeAssistantMessage(f.view,message(final.body,final.sources),{resultId:'result',fence:1})});assert.equal(JSON.stringify(f.view),before)
  }
})
test('restored same-request older-fence sealed parts survive reset while newer requests stay isolated',()=>{
  const f=fixture();f.seal(identity('a'),'old');f.view=ui.consumeRunStreamEvent(f.view,{type:'reset',runId:'run',reason:'unavailable'})
  f.view={...f.view,fence:2,requestVersion:1};assert.deepEqual(active(f.view).map(s=>s.text),['old'])
  f.view={...f.view,requestVersion:2};assert.deepEqual(segments(f.view),[])
})
test('legacy v1 and v2 keep their archive and are not duplicated by the v3 helper',()=>{
  let view=ui.createRunView('run');for(const [i,version] of [1,2].entries())view=ui.consumeRunEvent(view,{runId:'run',seq:i+1,kind:'public.text.delta',stage:'delta',visibility:'user',data:{version,...(version===2?{purpose:'answer'}:{}),requestVersion:1,fence:1,attemptId:'legacy',partId:`legacy-${i}`,partIndex:i,chunkIndex:0,text:'legacy'}})
  assert.equal(view.publicTextParts?.length,2);assert.deepEqual(segments(view),[])
})
test('a commit with missing source history preserves pending replacement until its trusted message arrives',()=>{
  const f=fixture(),a=identity('a'),r=identity('r',{segmentId:'a',operation:'replace',supersedes:['a']});f.seal(a,'old')
  f.emit('public.text.operation',r);f.emit('public.text.delta',r,{chunkIndex:0,text:'new'})
  const final=sources([{id:r,text:'new'}]);f.commit(final.sources)
  assert.deepEqual(active(f.view).map(s=>s.text),['old']);assert.equal(f.view.publicTextParts?.find(p=>p.partId==='r')?.acceptedResultId,null)
  f.view=ui.consumeAssistantMessage(f.view,message(final.body,final.sources),{resultId:'result',fence:1})
  assert.deepEqual(active(f.view).map(s=>[s.partId,s.text,s.status]),[['r','new','accepted']])
})
test('message-first late seal disagreement fails closed and cannot corrupt the accepted projection',()=>{
  const f=fixture(),id=identity('a'),final=sources([{id,text:'accepted'}]);f.view=ui.consumeAssistantMessage(f.view,message(final.body,final.sources),{resultId:'result',fence:1})
  f.emit('public.text.operation',id);f.emit('public.text.delta',id,{chunkIndex:0,text:'different'});f.emit('public.text.ended',id,{chunkCount:1,reason:'tool'})
  assert.throws(()=>f.emit('public.text.sealed',id,{chunkCount:1,bodyHash:sha('different')}),/archive/)
  assert.deepEqual(active(f.view).map(s=>s.text),['accepted'])
})
test('cancelled replacement and mutable input arrays cannot alter the retained original segment',()=>{
  const f=fixture(),a=identity('a'),r=identity('r',{segmentId:'a',operation:'replace',supersedes:['a']});f.seal(a,'old')
  f.emit('public.text.operation',r);r.supersedes!.push('other');assert.deepEqual(f.view.publicTextParts?.at(-1)?.supersedes,['a']);r.supersedes!.pop()
  f.emit('public.text.delta',r,{chunkIndex:0,text:'new'});f.emit('public.text.ended',r,{chunkCount:1,reason:'cancelled'})
  assert.deepEqual(active(f.view).map(s=>s.text),['old']);assert.equal(segments(f.view).find(s=>s.partId==='r')?.status,'pending-replacement')
})
test('an ended but unsealed answer stays incomplete and does not acquire commit authority',()=>{
  const f=fixture(),id=identity('a');f.emit('public.text.operation',id);f.emit('public.text.delta',id,{chunkIndex:0,text:'prefix'});f.emit('public.text.ended',id,{chunkCount:1,reason:'tool'})
  assert.deepEqual(active(f.view).map(s=>[s.text,s.status]),[['prefix','incomplete']]);assert.equal(f.view.publicTextParts?.[0]?.acceptedResultId,null)
})
test('one request and fence cannot acquire a conflicting result identity through message-first delivery',()=>{
  const f=fixture(),id=identity('a');f.seal(id,'answer');const final=sources([{id,text:'answer'}]);f.commit(final.sources);const before=JSON.stringify(f.view)
  assert.throws(()=>ui.consumeAssistantMessage(f.view,message(final.body,final.sources),{resultId:'different-result',fence:1}),/identity/)
  assert.equal(JSON.stringify(f.view),before);assert.deepEqual(active(f.view).map(s=>s.text),['answer'])
})
