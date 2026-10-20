import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS } from '../src/index.js'
import { createWorker } from '../src/worker/index.js'
import { OpenAIChatDriver } from '../src/model/openai.js'
import type { ModelDriver } from '../src/model/driver.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import { nullLogger } from '../src/logging.js'
import { consumePublicTextAttempts, consumeRunEvent, consumeRunState, createRunView } from '../src/ui/index.js'

for(const scenario of ['default','candidate-json','retry','write-failure'] as const)it(`public worker ${scenario}: channel isolation, attempt settlement and next request`,async()=>{
  const db=new PGlite(),directory=await mkdtemp(join(tmpdir(),'public-text-boundary-'))
  await db.exec(await readFile(new URL('../../db/schema.sql',import.meta.url),'utf8'))
  let tail=Promise.resolve(),failAppend=scenario==='write-failure',wire=0
  const acquire=async()=>{let release!:()=>void;const prior=tail;tail=new Promise<void>(resolve=>{release=resolve});await prior;return release}
  const query:SqlPool['query']=async(sql,params)=>{
    if(failAppend&&sql.includes('INSERT INTO lingxios.agent_run_events')&&params?.[4]==='public.text.delta')throw new Error('synthetic failed write')
    const r=await db.query<Record<string,unknown>>(sql,params);return {rows:r.rows,rowCount:r.affectedRows??r.rows.length}
  }
  const pool:SqlPool={async query(sql,params){const release=await acquire();try{return await query(sql,params)}finally{release()}},async connect(){return {query,release:await acquire()}}}
  const identity={runId:'boundary',tenantId:'tenant',principalId:'human',agentId:'agent',sessionId:'room'}
  const app=await createLingxiOS({database:pool,logger:nullLogger,homesRoot:directory,
    realtime:{allowDraft:()=>false,...scenario==='default'?{}:{allowPublicText:()=>true}}})
  const source=new OpenAIChatDriver(`public-boundary-${scenario}`,{apiKey:'fixture',maxAttempts:2,requestTimeoutMs:10_000,fetchImpl:async(_url,init)=>{
    const request=JSON.parse(String(init?.body))
    if(!request.stream)return Response.json({choices:[{finish_reason:'stop',message:{content:'{"missing":[]}'}}],usage:{prompt_tokens:11,completion_tokens:7}})
    wire++
    const failed=scenario==='retry'&&wire===1
    const text=scenario==='candidate-json'?JSON.stringify({body:'Hello.',status:'satisfied',gaps:[],checks:[{requirement:'Say hello.',status:'met',basis:'PRIVATE_CANDIDATE_SENTINEL'}]}):failed?'First partial.':'Hello.'
    return new Response(`data: ${JSON.stringify({choices:[{delta:{content:text,reasoning_content:'PRIVATE_REASONING_SENTINEL'},finish_reason:failed?'length':'stop'}],usage:{prompt_tokens:11,completion_tokens:7}})}\n\ndata: [DONE]\n\n`)
  }})
  const model:ModelDriver=scenario==='candidate-json'?{previewFormat:'candidate-json',profile:source.profile,modelId:source.modelId,
    run:request=>source.run(request),structured:request=>source.structured(request),compact:request=>source.compact(request)}:source
  const worker=createWorker({controlPlane:app,model,logger:nullLogger,kernel:{homesRoot:directory},worker:{id:'boundary-fixture',healthPort:0}})
  try{
    await app.enqueue({id:identity.runId,...identity,text:'Say hello.',mode:'chat',codeExecution:'disabled'})
    await worker.runNext()
    const state=await app.readRunState(identity),page=await app.readEvents(identity)
    assert.ok(state)
    let view=consumeRunState(createRunView(identity.runId),state)
    view=consumePublicTextAttempts(view,page.publicTextAttempts??[])
    for(const event of page.events)view=consumeRunEvent(view,event)
    assert.doesNotMatch(JSON.stringify(page),/PRIVATE_CANDIDATE_SENTINEL|PRIVATE_REASONING_SENTINEL/)
    if(scenario==='default'||scenario==='candidate-json'){
      assert.equal(view.publicTextParts?.length,0);assert.equal(state.message?.body,'Hello.');assert.equal(wire,1)
    }else if(scenario==='retry'){
      assert.equal(wire,2);assert.equal(state.message?.body,'Hello.')
      assert.deepEqual(view.publicTextParts?.map(part=>[part.text,part.reason]),[['First partial.','superseded'],['Hello.','completed']])
      assert.notEqual(view.publicTextParts?.[0]?.attemptId,view.publicTextParts?.[1]?.attemptId)
    }else{
      assert.equal(wire,1,'publication failure must not retry the provider')
      assert.equal(view.publicTextParts?.length,0);assert.equal(state.message,null)
      assert.equal((await app.readTerminal(identity))?.feedback.reason,'execution_failed')
    }
    const ledger=await pool.query('SELECT observation FROM lingxios.agent_model_budget_calls WHERE work_id=$1',[identity.runId])
    assert.equal(ledger.rows.filter(row=>(row['observation'] as {purpose:string})?.purpose==='agent-turn').length,wire)
    assert.ok(ledger.rows.every(row=>row['observation']))
    for(const row of ledger.rows){const observation=row['observation'] as {usage?:{available:boolean;inputTokens:number;outputTokens:number}};assert.deepEqual(observation.usage,{available:true,inputTokens:11,outputTokens:7})}
    if(scenario==='write-failure'){
      failAppend=false;const next={...identity,runId:'after-failure'}
      await app.enqueue({id:next.runId,...next,text:'Say hello.',mode:'chat',codeExecution:'disabled'});await worker.runNext()
      assert.equal((await app.readRunState(next))?.message?.body,'Hello.')
      assert.equal(wire,2)
    }
  }finally{await worker.stop();await app.stop();await db.close();await rm(directory,{recursive:true,force:true})}
})
