import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS } from '../src/index.js'
import { createWorker } from '../src/worker/index.js'
import { OpenAIChatDriver, type OpenAIDriverOptions } from '../src/model/openai.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import { nullLogger } from '../src/logging.js'
import { consumeRunEvent, consumeRunState, consumeRunStreamEvent, createRunView } from '../src/ui/index.js'

it('purpose-aware public worker streams a substantive answer before EOF, executes its tool and accepts only the final answer across SSE/replay', {timeout:15_000}, async t => {
  const db=new PGlite(), directory=await mkdtemp(join(tmpdir(),'public-text-worker-'))
  await db.exec(await readFile(new URL('../../db/schema.sql',import.meta.url),'utf8'))
  let tail=Promise.resolve()
  const acquire=async()=>{let release!:()=>void; const prior=tail;tail=new Promise<void>(resolve=>{release=resolve});await prior;return release}
  const query:SqlPool['query']=async(sql,params)=>{const r=await db.query<Record<string,unknown>>(sql,params);return {rows:r.rows,rowCount:r.affectedRows??r.rows.length}}
  const pool:SqlPool={async query(sql,params){const release=await acquire();try{return await query(sql,params)}finally{release()}},
    async connect(){return {query,release:await acquire()}}}
  const identity={runId:'public-run',tenantId:'tenant',principalId:'human',agentId:'agent',sessionId:'room'}
  let beforeTool=false,toolCalls=0,modelCalls=0,authorizations=0,providerStarted=0,durableAtTool=0,firstEof=false,answerBeforeEof=false
  let releaseFirst!:()=>void
  const firstPublished=new Promise<void>(resolve=>{releaseFirst=resolve})
  const realtime={allowDraft:()=>false,allowPublicText:()=>{authorizations++;return true}}
  const app=await createLingxiOS({database:pool,logger:nullLogger,realtime,homesRoot:directory,tools:[{
    action:'probe.read',name:'probe__read',description:'Read a synthetic record',parameters:{type:'object',properties:{},additionalProperties:false},
    effect:'read',approval:false,parse:()=>({}),authorize:async()=>{},execute:async context=>{
      toolCalls++
      const rows=await context.database.query("SELECT data FROM lingxios.agent_run_events WHERE run_id=$1 AND kind='public.text.delta'",[identity.runId])
      durableAtTool=performance.now()
      beforeTool=rows.rows.some(row=>String((row['data'] as Record<string,unknown>)['text']).includes('已知基础值是40。'))
      return {ok:true,value:{answer:42}}
    }}]})
  const driver=new OpenAIChatDriver('public-worker-fixture',{apiKey:'fixture',maxAttempts:1,publicTextProtocol:'purpose-json-v1',fetchImpl:async(_url,init)=>{
    const request=JSON.parse(String(init?.body))
    if(!request.stream)return Response.json({model:'fixture',choices:[{finish_reason:'stop',message:{content:'{"missing":[]}'}}],usage:{prompt_tokens:10,completion_tokens:5}})
    const first=++modelCalls===1
    if(first)providerStarted=performance.now()
    const frame=(delta:unknown,finish:string|null)=>`data: ${JSON.stringify({choices:[{delta,finish_reason:finish}],usage:{prompt_tokens:10,completion_tokens:5}})}\n\n`
    if(first)return new Response(new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode(frame({content:'{"commentary":"先检查记录","answer":"已知基础值是40。',reasoning_content:'PRIVATE_REASONING_SENTINEL'},null)))
    },async pull(controller){
      await firstPublished
      firstEof=true
      controller.enqueue(new TextEncoder().encode(frame({content:'"}',tool_calls:[{index:0,id:'probe',function:{name:'probe__read',arguments:'{}'}}]},'tool_calls')+'data: [DONE]\n\n'))
      controller.close()
    }}))
    return new Response(frame({content:JSON.stringify({commentary:'记录已读取',answer:'检查结果是42。'})},'stop')+'data: [DONE]\n\n')
  }} as OpenAIDriverOptions)
  // Keep this maxAttempts:1 fixture instance so the callback observes the real durable append.
  driver.singleAttempt=()=>driver
  const originalRun=driver.run.bind(driver)
  driver.run=request=>originalRun({...request,onTextDelta:async(text,metadata)=>{
    await request.onTextDelta?.(text,metadata)
    if(text==='已知基础值是40。'){
      const rows=await pool.query("SELECT data FROM lingxios.agent_run_events WHERE run_id=$1 AND kind='public.text.delta'",[identity.runId])
      answerBeforeEof=!firstEof&&rows.rows.some(row=>{const data=row['data'] as Record<string,unknown>;return data['purpose']==='answer'&&data['text']===text})
      releaseFirst()
    }
  }})
  const worker=createWorker({controlPlane:app,model:driver,logger:nullLogger,kernel:{homesRoot:directory},worker:{id:'public-fixture',healthPort:0}})
  try{
    await app.enqueue({id:identity.runId,...identity,text:'读取记录并告诉我结果',mode:'execute',codeExecution:'disabled'})
    await worker.runNext()
    const state=await app.readRunState(identity)
    assert.ok(state)
    assert.equal(toolCalls,1)
    assert.equal(beforeTool,true,'substantive answer must already be durable before native tool execution')
    assert.equal(answerBeforeEof,true,'answer must be durable before provider EOF, not buffered until the tool or final turn')
    assert.equal(modelCalls,2)
    assert.ok(authorizations>0)
    const events=await app.readEvents(identity)
    let replay=consumeRunState(createRunView(identity.runId),state)
    for(const event of events.events)replay=consumeRunEvent(replay,event)
    const parts=(Reflect.get(replay,'publicTextParts')??[]) as unknown as Array<{text:string;reason:string}>
    assert.ok(parts.some(part=>part.text==='已知基础值是40。'&&part.reason==='tool'))
    assert.equal(state.message?.body,'检查结果是42。')
    assert.equal(replay.publicTextParts?.length,4)
    assert.deepEqual(replay.publicTextParts?.map(part=>Reflect.get(part,'purpose')),['commentary','answer','commentary','answer'])
    assert.deepEqual(replay.publicTextParts?.map(part=>Reflect.get(part,'acceptedResultId')),[null,null,null,state.run.resultId])
    assert.equal(Reflect.get(state.message!,'publicTextPartId'),replay.publicTextParts?.[3]?.partId)
    const commit=events.events.find(event=>event.kind==='response.committed')
    assert.equal(commit?.data['publicTextPartId'],replay.publicTextParts?.[3]?.partId)
    assert.equal(replay.publicTextParts?.filter(part=>!Reflect.get(part,'acceptedResultId')).length,3,'only the final answer is accepted; tool-turn answer stays in the public archive')
    const started=events.events.find(event=>event.kind==='tool.started'&&event.data['name']==='probe.read')
    assert.ok(started)
    const completed=events.events.find(event=>event.kind==='tool.completed'&&event.data['toolCallId']===started.data['toolCallId'])
    assert.ok(completed)
    for(const event of [started,completed]){
      assert.equal(event.data['requestVersion'],1);assert.equal(event.data['fence'],1)
      assert.equal(event.data['attemptId'],replay.publicTextParts?.[0]?.attemptId)
    }
    t.diagnostic(`synthetic provider first content to native tool reading durable prefix: ${(durableAtTool-providerStarted).toFixed(2)}ms; tool executions=${toolCalls}`)
    assert.doesNotMatch(JSON.stringify(events),/PRIVATE_REASONING_SENTINEL/)
    const trace=await app.readRunTrace(identity)
    assert.ok(trace?.origin)
    const agentSpan=trace.spans.find(span=>span.spanId===trace.rootSpanId)!
    assert.equal(agentSpan.state,state.run.status==='succeeded'?'complete':'unknown');assert.ok(agentSpan.completedAt!>=trace.origin)
    const modelSpans=trace.spans.filter(span=>span.kind==='llm')
    assert.ok(modelSpans.length>=2)
    for(const span of modelSpans){assert.ok(span.startedAt);assert.ok(span.completedAt!>=span.startedAt!);assert.equal(span.requestVersion,1)}
    const toolSpan=trace.spans.find(span=>span.toolCallId===started.data['toolCallId'])!
    assert.equal(toolSpan.state,'complete');assert.equal(toolSpan.attemptId,replay.publicTextParts?.[0]?.attemptId)
    assert.ok(toolSpan.completedAt!>=toolSpan.startedAt!)
    assert.doesNotMatch(JSON.stringify(trace),/PRIVATE_REASONING_SENTINEL|instructionsSha256|prompt|inputSha256|lease_token/)
    const response=await app.streamRun(identity,{trace:true})
    assert.match(response.headers.get('content-type')??'',/text\/event-stream/)
    const wire=await response.text()
    let streamed=createRunView(identity.runId)
    for(const frame of wire.split('\n\n')){
      const line=frame.split('\n').find(line=>line.startsWith('data: '))
      if(line)streamed=consumeRunStreamEvent(streamed,JSON.parse(line.slice(6)))
    }
    assert.deepEqual(streamed.publicTextParts,replay.publicTextParts)

  }finally{await worker.stop();await app.stop();await db.close();await rm(directory,{recursive:true,force:true})}
})
