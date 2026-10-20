import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS } from '../src/index.js'
import { createWorker } from '../src/worker/index.js'
import { OpenAIChatDriver } from '../src/model/openai.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import { nullLogger } from '../src/logging.js'
import { consumeRunEvent, consumeRunState, createRunView } from '../src/ui/index.js'

it('public worker persists user text before a native tool and replays it after final delivery', async t => {
  const db=new PGlite(), directory=await mkdtemp(join(tmpdir(),'public-text-worker-'))
  await db.exec(await readFile(new URL('../../db/schema.sql',import.meta.url),'utf8'))
  let tail=Promise.resolve()
  const acquire=async()=>{let release!:()=>void; const prior=tail;tail=new Promise<void>(resolve=>{release=resolve});await prior;return release}
  const query:SqlPool['query']=async(sql,params)=>{const r=await db.query<Record<string,unknown>>(sql,params);return {rows:r.rows,rowCount:r.affectedRows??r.rows.length}}
  const pool:SqlPool={async query(sql,params){const release=await acquire();try{return await query(sql,params)}finally{release()}},
    async connect(){return {query,release:await acquire()}}}
  const identity={runId:'public-run',tenantId:'tenant',principalId:'human',agentId:'agent',sessionId:'room'}
  let beforeTool=false,toolCalls=0,modelCalls=0,authorizations=0,providerStarted=0,durableAtTool=0
  const realtime={allowDraft:()=>false,allowPublicText:()=>{authorizations++;return true}}
  const app=await createLingxiOS({database:pool,logger:nullLogger,realtime,homesRoot:directory,tools:[{
    action:'probe.read',name:'probe__read',description:'Read a synthetic record',parameters:{type:'object',properties:{},additionalProperties:false},
    effect:'read',approval:false,parse:()=>({}),authorize:async()=>{},execute:async context=>{
      toolCalls++
      const rows=await context.database.query("SELECT data FROM lingxios.agent_run_events WHERE run_id=$1 AND kind='public.text.delta'",[identity.runId])
      durableAtTool=performance.now()
      beforeTool=rows.rows.some(row=>String((row['data'] as Record<string,unknown>)['text']).includes('先检查记录'))
      return {ok:true,value:{answer:42}}
    }}]})
  const driver=new OpenAIChatDriver('public-worker-fixture',{apiKey:'fixture',maxAttempts:1,fetchImpl:async(_url,init)=>{
    const request=JSON.parse(String(init?.body))
    if(!request.stream)return Response.json({model:'fixture',choices:[{finish_reason:'stop',message:{content:'{"missing":[]}'}}],usage:{prompt_tokens:10,completion_tokens:5}})
    const first=++modelCalls===1
    if(first)providerStarted=performance.now()
    const delta=first?{content:'先检查记录',reasoning_content:'PRIVATE_REASONING_SENTINEL',tool_calls:[{index:0,id:'probe',function:{name:'probe__read',arguments:'{}'}}]}:{content:'检查结果是42。'}
    return new Response(`data: ${JSON.stringify({choices:[{delta,finish_reason:first?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5}})}\n\ndata: [DONE]\n\n`)
  }})
  const worker=createWorker({controlPlane:app,model:driver,logger:nullLogger,kernel:{homesRoot:directory},worker:{id:'public-fixture',healthPort:0}})
  try{
    await app.enqueue({id:identity.runId,...identity,text:'读取记录并告诉我结果',mode:'execute',codeExecution:'disabled'})
    await worker.runNext()
    const state=await app.readRunState(identity)
    assert.ok(state)
    assert.equal(toolCalls,1)
    assert.equal(beforeTool,true,'public text must already be durable before native tool execution')
    assert.ok(authorizations>0)
    const events=await app.readEvents(identity)
    let replay=consumeRunState(createRunView(identity.runId),state)
    for(const event of events.events)replay=consumeRunEvent(replay,event)
    const parts=(Reflect.get(replay,'publicTextParts')??[]) as unknown as Array<{text:string;reason:string}>
    assert.ok(parts.some(part=>part.text==='先检查记录'&&part.reason==='tool'))
    assert.equal(state.message?.body,'检查结果是42。')
    assert.equal(replay.publicTextParts?.length,2)
    assert.deepEqual(replay.publicTextParts?.map(part=>Reflect.get(part,'acceptedResultId')),[null,state.run.resultId])
    assert.equal(Reflect.get(state.message!,'publicTextPartId'),replay.publicTextParts?.[1]?.partId)
    const commit=events.events.find(event=>event.kind==='response.committed')
    assert.equal(commit?.data['publicTextPartId'],replay.publicTextParts?.[1]?.partId)
    assert.equal(replay.publicTextParts?.filter(part=>!Reflect.get(part,'acceptedResultId')).length,1,'main display keeps the tool preface only; all parts remain in history')
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
  }finally{await worker.stop();await app.stop();await db.close();await rm(directory,{recursive:true,force:true})}
})
