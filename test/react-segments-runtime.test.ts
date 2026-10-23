import assert from 'node:assert/strict'
import {it} from 'node:test'
import {createHash} from 'node:crypto'
import {readFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PGlite} from '@electric-sql/pglite'
import {createLingxiOS} from '../src/index.js'
import {createWorker} from '../src/worker/index.js'
import {OpenAIChatDriver} from '../src/model/openai.js'
import {AnswerSegmentSet,type SealedAnswerSegment} from '../src/runtime/answer-segments.js'
import {validateToolBatch,compileToolSchemas} from '../src/runtime/tool-batch.js'
import {TASK_TOOLS,type ToolDefinition} from '../src/tools/catalog.js'
import type {SqlPool} from '../src/control-plane/pg-store.js'
import {LeaseLostError} from '../src/errors.js'
import {nullLogger} from '../src/logging.js'
const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
const record=(partId:string,text:string,supersedes:string[]=[],segmentId=partId):SealedAnswerSegment=>({text,bodyHash:hash(text),identity:{version:3,purpose:'answer',messageId:'answer:run:v1',requestVersion:1,fence:1,attemptId:partId,partId,segmentId,partIndex:1,operation:supersedes.length?'replace':'append',supersedes}})

it('direct LangGraph ID reduction preserves ordered append, explicit in-place replace and immutable sealed archives',()=>{
  const set=new AnswerSegmentSet('run',1,2)
  const a=record('a',' A'),b=record('b','B'),c=record('c','C ')
  for(const value of [a,b,c])set.seal(value)
  assert.equal(set.assemble().body,'ABC')
  set.seal(b);assert.equal(set.records.length,3,'same immutable revision replay is idempotent')
  assert.throws(()=>set.seal(record('b','changed')),/immutable/)
  assert.throws(()=>set.prepare({kind:'replace',supersedes:['c','a']},'r'),/order/)
  assert.throws(()=>set.prepare({kind:'replace',supersedes:['missing']},'r'),/active/)
  set.seal(record('r','Q',['a','b'],'a'));assert.equal(set.assemble().body,'QC')
  assert.deepEqual(set.records.map(item=>item.identity.segmentId),['a','c'])
  assert.deepEqual([a.text,b.text,c.text],[' A','B','C '],'source records remain immutable')
  set.seal(record('d','C '));assert.equal(set.assemble().body,'QC C','equal text with a new logical identity is not deduplicated')
  assert.throws(()=>set.seal({...record('other','X'),identity:{...record('other','X').identity,requestVersion:2}}),/invalid/)
})

const probe:ToolDefinition={name:'probe__read',action:'probe.read',description:'Read a synthetic integer.',parameters:{type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false},effect:'read',approval:false}
it('all catalog arguments are checked without coercion or side effects before any tool dispatch',()=>{
  compileToolSchemas(TASK_TOOLS)
  const call=(id:string,args:string)=>({type:'function_call' as const,callId:id,name:probe.name,arguments:args})
  const calls=[call('one','{"value":1}'),call('two','{"value":"2"}')]
  assert.throws(()=>validateToolBatch(calls,[probe],'disabled',true),/schema/)
  assert.equal(calls[1]!.arguments,'{"value":"2"}')
  assert.throws(()=>validateToolBatch([call('one','{"value":1}'),call('one','{"value":2}')],[probe],'disabled',true),/identity/)
  assert.throws(()=>compileToolSchemas([{...probe,parameters:{...probe.parameters,properties:{value:{unrecognizedAssertion:true}}}}]),/unknown keyword/)
})

type Reply={answer:string|null;tool?:number;badSecond?:boolean;replace?:boolean;partial?:boolean;intermediate?:boolean}
async function fixture(replies:Reply[],allowed=true,text='Read the synthetic record and explain the result.',continuation=false,fault?:'seal'|'second-seal'|'cancel',maxCalls?:number,fastOnly=false){
  const db=new PGlite(),home=await mkdtemp(join(tmpdir(),'react-runtime-'))
  await db.exec(await readFile(new URL('../../db/schema.sql',import.meta.url),'utf8'))
  let tail=Promise.resolve(),modelCalls=0,effects=0,auxiliaryCalls=0,faulted=false,seals=0
  const requests:Array<{messages:Array<{content:unknown}>}>=[]
  const acquire=async()=>{let release!:()=>void;const previous=tail;tail=new Promise<void>(r=>{release=r});await previous;return release}
  const query:SqlPool['query']=async(sql,params)=>{const r=await db.query<Record<string,unknown>>(sql,params);return {rows:r.rows,rowCount:r.affectedRows??r.rows.length}}
  const pool:SqlPool={async query(sql,params){const release=await acquire();try{return await query(sql,params)}finally{release()}},async connect(){return {query,release:await acquire()}}}
  const app=await createLingxiOS({...(fastOnly?{responsePolicy:'auto' as const}:{}),database:pool,homesRoot:home,logger:nullLogger,delivery:{onEvent:async()=>{},deliverMessage:async()=>({messageId:'synthetic-receipt'})},realtime:{allowPublicText:()=>allowed},tools:[{...probe,parse:args=>args as Record<string,unknown>,authorize:async()=>{},execute:async()=>{effects++;return {ok:true,value:{value:2}}}}]})
  const connect=app.connectWorker.bind(app)
  app.connectWorker=options=>{
    const host=connect(options),emit=host.emitEvent.bind(host)
    host.emitEvent=async(work,event,signal)=>{
      await emit(work,event,signal)
      if(event.kind==='public.text.sealed')seals++
      if(fault&&!faulted&&event.kind==='public.text.sealed'&&(fault!=='second-seal'||seals===2)){
        faulted=true
        if(fault==='cancel'){await app.cancel(identity);return}
        await pool.query("UPDATE lingxios.agent_work_items SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[work.id])
        await pool.query("UPDATE lingxios.agent_os_session_leases SET expires_at=NOW()-INTERVAL '1 second' WHERE work_id=$1",[work.id])
        throw new LeaseLostError('synthetic lost seal acknowledgement')
      }
    };return host
  }
  const fetchImpl:typeof fetch=async(_url,init)=>{
    const request=JSON.parse(String(init?.body)) as {stream?:boolean;messages:Array<{content:unknown}>}
    requests.push(request)
    if(!request.stream){auxiliaryCalls++;throw new Error('ordinary ReAct must not call a judge')}
    const reply=replies[modelCalls++]??{answer:null,partial:true}
    const rows=await pool.query("SELECT input FROM lingxios.agent_steps WHERE kind='runtime.answer_segment' ORDER BY step_seq")
    const supersedes=reply.replace?rows.rows.map(row=>String((row['input'] as Record<string,unknown>)['partId'])):[]
    const content=JSON.stringify({operation:{kind:reply.replace?'replace':'append',supersedes},commentary:'',answer:reply.answer,outcome:reply.tool===undefined&&!reply.intermediate?{status:reply.partial?'partial':'satisfied',gaps:reply.partial?['Synthetic limitation.']:[]}:null})
    const calls=reply.tool===undefined?undefined:[{index:0,id:`call-${modelCalls}`,function:{name:probe.name,arguments:JSON.stringify({value:reply.tool})}},...reply.badSecond?[{index:1,id:`bad-${modelCalls}`,function:{name:probe.name,arguments:'{"value":"invalid"}'}}]:[]]
    const frame=(delta:unknown,finish:string|null)=>`data: ${JSON.stringify({choices:[{delta,finish_reason:finish}],usage:{prompt_tokens:20,completion_tokens:10}})}\n\n`
    return new Response(frame({content},null)+frame(calls?{tool_calls:calls}:{},calls?'tool_calls':'stop')+'data: [DONE]\n\n')
  }
  const options={apiKey:'fixture',publicTextProtocol:'purpose-json-v3' as const,maxAttempts:1,capabilities:{parallelTools:true,jsonObjectWithTools:true},fetchImpl}
  const driver=new OpenAIChatDriver('react-fixture',{...options,...(continuation?{publicTextContinuation:'typed-message-v1' as const}:{})})
  const model=fastOnly?new OpenAIChatDriver('deep-terminal-only',options):driver
  const worker=createWorker({...(maxCalls?{modelBudget:{maxModelCalls:maxCalls}}:{}),controlPlane:app,model,...(fastOnly?{fastModel:driver}:{}),logger:nullLogger,kernel:{homesRoot:home},worker:{id:'react-worker',healthPort:0}})
  const identity={runId:'react-runtime',tenantId:'tenant',principalId:'human',agentId:'agent',sessionId:'room'}
  await app.enqueue({id:identity.runId,...identity,text,mode:'execute',codeExecution:'disabled',deliveryMode:'auto'})
  return {app,pool,identity,driver,worker,requests,async restart(){await worker.stop();const replacement=createWorker({controlPlane:app,model,...(fastOnly?{fastModel:driver}:{}),logger:nullLogger,kernel:{homesRoot:home},worker:{id:'replacement-worker',healthPort:0}});try{await replacement.runNext();return (await app.readRunState(identity))!}finally{await replacement.stop()}},get calls(){return modelCalls},get effects(){return effects},get auxiliary(){return auxiliaryCalls},setAllowed(value:boolean){allowed=value},async run(){await worker.runNext();return (await app.readRunState(identity))!},async close(){await worker.stop();await app.stop();await db.close();await rm(home,{recursive:true,force:true})}}
}

it('full Worker answers a plain number in one generation without tools or semantic review',async()=>{
  const f=await fixture([{answer:'43'}],true,'What is 17 + 26? Reply with only the number.')
  try{
    const state=await f.run()
    assert.equal(state.run.status,'succeeded')
    assert.equal(state.message?.body,'43')
    assert.deepEqual({modelCalls:f.calls,effects:f.effects,auxiliaryCalls:f.auxiliary},{modelCalls:1,effects:0,auxiliaryCalls:0})
    assert.equal(state.message?.publicTextSources?.segments.length,1)
    assert.equal(state.message?.publicTextSources?.bodyHash,hash('43'))
  }finally{await f.close()}
})

it('full Worker appends A → tool → B → tool → null final and atomically binds all sealed sources',async()=>{
  const f=await fixture([{answer:' A',tool:1},{answer:'B ',tool:2},{answer:null}])
  try{
    const state=await f.run()
    const events=await f.app.readEvents(f.identity)
    assert.equal(state.run.status,'succeeded',JSON.stringify(events.events.filter(e=>e.kind==='run.failed').map(e=>e.data)))
    assert.equal(state.message?.body,'AB');assert.equal(f.calls,3);assert.equal(f.effects,2);assert.equal(f.auxiliary,0)
    assert.equal(state.message!.publicTextSources!.segments.length,2)
    assert.equal(state.message!.publicTextSources!.bodyHash,hash('AB'))
    assert.deepEqual(state.message!.publicTextSources!.segments.map(s=>[s.start,s.end]),[[0,1],[1,2]])
    assert.equal(events.events.filter(e=>e.kind==='model.delta').length,0,'the final message must not replay accumulated body')
    assert.equal(events.events.filter(e=>e.kind==='public.text.sealed').length,2)
    const commit=events.events.find(e=>e.kind==='response.committed')
    assert.deepEqual(commit?.data['publicTextSources'],state.message!.publicTextSources)
    const rows=await f.pool.query('SELECT result.message FROM lingxios.agent_delivery_outbox outbox JOIN lingxios.agent_results result ON result.id=outbox.result_id WHERE result.work_id=$1',[f.identity.runId])
    assert.equal(rows.rows.length,1)
  }finally{await f.close()}
})

it('explicit replace changes one stable logical source only at verified final commit',async()=>{
  const f=await fixture([{answer:'Old useful body.',tool:1},{answer:'Corrected useful body.',replace:true}])
  try{const state=await f.run();assert.equal(state.run.status,'succeeded');assert.equal(state.message!.body,'Corrected useful body.')
    const rows=await f.pool.query("SELECT input FROM lingxios.agent_steps WHERE kind='runtime.answer_segment' ORDER BY step_seq")
    assert.equal(rows.rows.length,2);const a=rows.rows[0]!['input'] as Record<string,unknown>,b=rows.rows[1]!['input'] as Record<string,unknown>
    assert.equal(a['segmentId'],b['segmentId']);assert.notEqual(a['partId'],b['partId'])
    assert.equal(state.message!.publicTextSources!.segments[0]!.partId,b['partId'])
  }finally{await f.close()}
})

it('malformed later tool arguments dispatch no earlier effects and preserve the bounded correction policy',async()=>{
  const f=await fixture([{answer:'Pending.',tool:1,badSecond:true},{answer:'Unable to perform the invalid batch.',partial:true}])
  try{const state=await f.run();assert.equal(state.run.status,'partial');assert.equal(f.effects,0);assert.equal(f.calls,2)
    const events=await f.app.readEvents(f.identity)
    assert.equal(events.events.filter(e=>e.kind==='public.text.sealed').length,1)
    assert.equal(state.message?.body,'Unable to perform the invalid batch.')
  }finally{await f.close()}
})

it('a public run without publication permission fails before provider admission instead of routing to private v2',async()=>{
  const f=await fixture([{answer:'Forbidden.'}],false)
  try{const state=await f.run();assert.equal(state.run.status,'failed');assert.equal(f.calls,0);assert.equal(state.message,null)
    assert.equal((await f.app.readEvents(f.identity)).events.some(e=>e.kind.startsWith('public.text.')),false)
  }finally{await f.close()}
})

it('failed replacement preserves the prior valid collection as explicitly partial instead of accepting the replacement',async()=>{
  const f=await fixture([{answer:'Original useful answer.',tool:1},{answer:'Bad [citation](#cite-S999).',replace:true},{answer:null},{answer:null}])
  try{const state=await f.run();assert.equal(state.run.status,'partial');assert.equal(state.message?.body,'Original useful answer.')
    assert.equal(state.message!.envelope.goalOutcome.verification,'inconclusive')
    assert.equal(state.message!.publicTextSources!.segments.length,1)
    const rows=await f.pool.query("SELECT input FROM lingxios.agent_steps WHERE kind='runtime.answer_segment' ORDER BY step_seq")
    assert.equal(rows.rows.length,2,'the failed immutable revision remains archived')
    assert.equal(state.message!.publicTextSources!.segments[0]!.partId,(rows.rows[0]!['input'] as Record<string,unknown>)['partId'])
    assert.equal(f.effects,1,'repairing response text must not repeat the recorded effect')
  }finally{await f.close()}
})

it('an invalid citation in an earlier segment cannot disappear behind a valid final suffix',async()=>{
  const f=await fixture([{answer:'Bad [citation](#cite-S999).',tool:1},{answer:' Valid suffix.'},{answer:null},{answer:null}])
  try{const state=await f.run();assert.equal(state.run.status,'failed');assert.equal(state.message,null)
    assert.equal(f.effects,1)
  }finally{await f.close()}
})

it('declared draft-2020 schemas validate standard URI and date-time without deleting formats',()=>{
  const schema={...probe,parameters:{...probe.parameters,$schema:'https://json-schema.org/draft/2020-12/schema',
    properties:{url:{type:'string',format:'uri'},at:{type:'string',format:'date-time'}},required:['url','at']}}
  compileToolSchemas([schema])
  const call=(args:unknown)=>[{type:'function_call' as const,callId:'formats',name:probe.name,arguments:JSON.stringify(args)}]
  validateToolBatch(call({url:'https://example.org/item',at:'2026-10-23T12:00:00Z'}),[schema],'disabled')
  for(const args of [{url:'not a URI',at:'2026-10-23T12:00:00Z'},{url:'https://example.org/item',at:'2026-99-99'}])assert.throws(()=>validateToolBatch(call(args),[schema],'disabled'),/schema/)
})


it('explicit intermediate A → native tool → B → null final preserves one answer and normal generation count',async()=>{
  const f=await fixture([{answer:' A ',intermediate:true},{answer:'',tool:2},{answer:'B ',intermediate:true},{answer:null}],true,'Read and explain.',true)
  try{const state=await f.run();assert.equal(state.run.status,'succeeded');assert.equal(state.message?.body,'A B')
    assert.equal(f.calls,4);assert.equal(f.effects,1);assert.equal(f.auxiliary,0)
    const events=(await f.app.readEvents(f.identity)).events
    assert.equal(events.filter(e=>e.kind==='public.text.sealed').length,2)
    assert.equal(events.filter(e=>e.kind==='response.committed').length,1)
    const steps=await f.pool.query("SELECT kind FROM lingxios.agent_steps WHERE kind='runtime.answer_segment'")
    assert.equal(steps.rows.length,2);assert.equal(state.message?.publicTextSources?.segments.length,2)
  }finally{await f.close()}
})
it('continuation opt-in arithmetic still delivers in one generation without a tool or judge',async()=>{
  const f=await fixture([{answer:'43'}],true,'What is 17 + 26?',true)
  try{const state=await f.run();assert.equal(state.run.status,'succeeded');assert.equal(state.message?.body,'43');assert.equal(f.calls,1);assert.equal(f.effects,0);assert.equal(f.auxiliary,0)}finally{await f.close()}
})

it('durable intermediate seal survives lost acknowledgement before history save and resumes without replay',async()=>{
  const f=await fixture([{answer:'A known fact. ',intermediate:true},{answer:'',tool:2},{answer:'B observed result.',intermediate:true},{answer:null}],true,'Read and explain.',true,'seal')
  try{await f.run();assert.equal(f.calls,1);assert.equal(f.effects,0)
    const state=await f.restart();assert.equal(state.run.status,'succeeded');assert.equal(state.run.fence,2)
    assert.equal(state.message?.body,'A known fact. B observed result.');assert.equal(f.calls,4);assert.equal(f.effects,1)
    assert.equal(JSON.stringify(f.requests[1]).split('A known fact. ').length-1,1,'recovered body occurs once in the next model request')
    const events=(await f.app.readEvents(f.identity)).events
    assert.equal(events.filter(e=>e.kind==='public.text.sealed').length,2)
    assert.equal(events.filter(e=>e.kind==='public.text.delta'&&e.data['text']==='A known fact. ').length,1)
    assert.equal(events.some(e=>JSON.stringify(e).includes('publicTextRecovery')),false,'private provenance never enters public events')
  }finally{await f.close()}
})
it('cancellation after intermediate seal prevents a subsequent native dispatch or terminal commit',async()=>{
  const f=await fixture([{answer:'A known fact.',intermediate:true},{answer:'',tool:2}],true,'Read and explain.',true,'cancel')
  try{const state=await f.run();assert.equal(state.run.status,'cancelled');assert.equal(f.calls,1);assert.equal(f.effects,0);assert.equal(state.message,null)
    assert.equal((await f.app.readEvents(f.identity)).events.filter(e=>e.kind==='public.text.sealed').length,1)
  }finally{await f.close()}
})

it('restart after a later sealed message retains prior saved history once and never repeats the completed tool',async()=>{
  const f=await fixture([{answer:'A known fact. ',intermediate:true},{answer:'',tool:2},{answer:'B observed result.',intermediate:true},{answer:null}],true,'Read and explain.',true,'second-seal')
  try{await f.run();assert.equal(f.calls,3);assert.equal(f.effects,1)
    const state=await f.restart();assert.equal(state.run.status,'succeeded');assert.equal(state.message?.body,'A known fact. B observed result.')
    assert.equal(f.calls,4);assert.equal(f.effects,1)
    const next=JSON.stringify(f.requests[3]);assert.equal(next.split('A known fact. ').length-1,1);assert.equal(next.split('B observed result.').length-1,1)
    assert.equal((await f.app.readEvents(f.identity)).events.filter(e=>e.kind==='public.text.sealed').length,2)
  }finally{await f.close()}
})
it('an explicit partial terminal declaration after intermediate content cannot become satisfied',async()=>{
  const f=await fixture([{answer:'Known portion. ',intermediate:true},{answer:'Missing the requested observation.',partial:true}],true,'Read and explain.',true)
  try{const state=await f.run();assert.equal(state.run.status,'partial');assert.equal(state.message?.body,'Known portion. Missing the requested observation.');assert.equal(f.calls,2);assert.equal(f.effects,0)}finally{await f.close()}
})

it('repeated intermediate items consume the existing global model budget without declaring completion',async()=>{
  const f=await fixture(Array.from({length:5},(_,i)=>({answer:`Known fact ${i}. `,intermediate:true})),true,'Explain the known facts.',true,undefined,3)
  try{const state=await f.run();assert.equal(state.run.status,'failed');assert.equal(f.calls,3);assert.equal(f.effects,0);assert.equal(state.message,null)
    const events=(await f.app.readEvents(f.identity)).events
    assert.equal(events.filter(e=>e.kind==='public.text.sealed').length,3);assert.equal(events.filter(e=>e.kind==='response.committed').length,0)
  }finally{await f.close()}
})

it('fast-only continuation restores its sealed body when restart selects terminal-only deep',async()=>{
  const f=await fixture([{answer:'Known answer.',intermediate:true},{answer:null}],true,'Explain.',true,'seal',undefined,true)
  try{const initial=await f.run();assert.equal(f.calls,1,JSON.stringify(initial.run))
    const state=await f.restart();assert.equal(state.run.status,'succeeded',JSON.stringify(state.run));assert.equal(f.calls,2);assert.equal(state.message?.body,'Known answer.')
    assert.equal(JSON.stringify(f.requests[1]).split('Known answer.').length-1,1)
  }finally{await f.close()}
})
