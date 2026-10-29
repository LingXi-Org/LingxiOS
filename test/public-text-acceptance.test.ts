import { createHash } from 'node:crypto'
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
import type { ConversationPolicy } from '../src/collaboration/types.js'
import { nullLogger } from '../src/logging.js'
import { consumeRunEvent, consumeRunState, createRunView } from '../src/ui/index.js'

for(const scenario of ['commit-failure','commit-ack-loss','cancel','revoke','revision','invalid-source','unrelated-source','existing-candidate-limit','commentary-source'] as const)it(`public source association is atomic: ${scenario}`,async()=>{
  const db=new PGlite(),directory=await mkdtemp(join(tmpdir(),'public-text-acceptance-'))
  await db.exec(await readFile(new URL('../../db/schema.sql',import.meta.url),'utf8'))
  let tail=Promise.resolve(),resultInTransaction=false,armed=false,injected=false,replayed=false
  const acquire=async()=>{let release!:()=>void;const prior=tail;tail=new Promise<void>(resolve=>{release=resolve});await prior;return release}
  const query:SqlPool['query']=async(sql,params)=>{
    if(sql==='BEGIN')resultInTransaction=false
    if(sql.includes('INSERT INTO lingxios.agent_results')){
      if(armed&&scenario==='commit-failure'){injected=true;armed=false;throw new Error('synthetic result failure')}
      resultInTransaction=true
    }
    const r=await db.query<Record<string,unknown>>(sql,params)
    if(sql==='COMMIT'&&armed&&resultInTransaction&&scenario==='commit-ack-loss'){
      injected=true;armed=false;throw new Error('synthetic lost COMMIT acknowledgement')
    }
    return {rows:r.rows,rowCount:r.affectedRows??r.rows.length}
  }
  const pool:SqlPool={async query(sql,params){const release=await acquire();try{return await query(sql,params)}finally{release()}},async connect(){return {query,release:await acquire()}}}
  const app=await createLingxiOS({tools:[{action:'probe.read',name:'probe__read',description:'Synthetic read',effect:'read',approval:false,parameters:{type:'object',properties:{},additionalProperties:false},parse:()=>({}),authorize:async()=>{},execute:async()=>({ok:true,value:42})}],database:pool,logger:nullLogger,homesRoot:directory,realtime:{allowDraft:()=>false,allowPublicText:()=>true}})
  const policy:ConversationPolicy={tenantId:'tenant',conversationId:'room',version:1,kind:'group',owner:{kind:'participant',id:'human'},defaultAgentId:'agent',participants:[
    {id:'human',kind:'human',capabilities:['read','execute']},{id:'agent',kind:'agent',capabilities:['read','execute','speak']}]}
  await app.conversations.sync(policy)
  const identity=(await app.conversations.ingest({tenantId:'tenant',conversationId:'room',policyVersion:1,messageId:'message',version:1,
    author:{id:'human',kind:'human'},text:'Say hello.'},{mode:'chat',codeExecution:'disabled'})).runs[0]!
  const finalBody=scenario==='existing-candidate-limit'?'x'.repeat(100_001):'Hello.'
  let attempted=0,firstPartId:string|undefined,modelCalls=0
  const connection={connectWorker(input:{workerId:string;workKinds:readonly string[]}){
    const host=app.connectWorker(input)
    return {...host,emitEvent:async(work:Parameters<typeof host.emitEvent>[0],event:Parameters<typeof host.emitEvent>[1])=>{
      if(event.kind==='public.text.delta')firstPartId??=String(event.data['partId'])
      return host.emitEvent(work,event)
    },commitResult:async(work:Parameters<typeof host.commitResult>[0],message:Parameters<typeof host.commitResult>[1])=>{
      attempted++;assert.ok(message.publicTextPartId)
      if(scenario==='cancel')await app.cancel(identity)
      if(scenario==='revision')await app.revise(identity,'Changed requirement')
      if(scenario==='revoke')await app.conversations.sync({...policy,version:2,participants:policy.participants.map(p=>p.id==='agent'?{...p,capabilities:['read','execute']}:p)})
      if(scenario==='invalid-source')message={...message,publicTextPartId:'unrelated-part'}
      if(scenario==='unrelated-source'){assert.ok(firstPartId);assert.notEqual(firstPartId,message.publicTextPartId);message={...message,publicTextPartId:firstPartId}}
      if(scenario==='commentary-source'){
        assert.ok(firstPartId);assert.notEqual(firstPartId,message.publicTextPartId)
        await host.saveStep(work,{id:'forged-commentary-source',kind:'runtime.public_text_source',requestVersion:message.envelope.requestVersion,
          input:{publicTextPartId:firstPartId,publicTextBodyHash:createHash('sha256').update(message.body).digest('hex')},output:'{}',artifacts:[]})
        message={...message,publicTextPartId:firstPartId}
      }
      armed=true
      try{await host.commitResult(work,message)}catch(error){
        if(scenario!=='commit-ack-loss')throw error
        assert.equal(injected,true)
        await host.commitResult(work,message);replayed=true
      }
    }}
  }}
  const model=new OpenAIChatDriver('acceptance-fixture',{apiKey:'fixture',maxAttempts:1,...(scenario==='commentary-source'?{publicTextProtocol:'purpose-json-v2' as const}:{}),fetchImpl:async(_url,init)=>{
    const request=JSON.parse(String(init?.body))
    if(!request.stream)return Response.json({choices:[{finish_reason:'stop',message:{content:'{"missing":[]}'}}],usage:{prompt_tokens:11,completion_tokens:7}})
    modelCalls++
    if(scenario==='unrelated-source'&&modelCalls===1)return new Response('data: {"choices":[{"delta":{"content":"Tool preface.","tool_calls":[{"index":0,"id":"probe","function":{"name":"probe__read","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\ndata: [DONE]\n\n')
    return new Response(`data: ${JSON.stringify({choices:[{delta:{content:scenario==='commentary-source'?JSON.stringify({commentary:finalBody,answer:finalBody,outcome:{status:'satisfied',gaps:[]}}):finalBody},finish_reason:'stop'}],usage:{prompt_tokens:11,completion_tokens:7}})}\n\ndata: [DONE]\n\n`)
  }})
  const worker=createWorker({controlPlane:connection,model,logger:nullLogger,kernel:{homesRoot:directory},worker:{id:'acceptance-fixture',healthPort:0}})
  try{
    await worker.runNext()
    assert.equal(attempted,scenario==='existing-candidate-limit'?0:1,'the existing control-plane 100k candidate check runs before result commit')
    const state=await app.readRunState(identity),page=await app.readEvents(identity);assert.ok(state)
    let view=consumeRunState(createRunView(identity.runId),state)
    for(const event of page.events)view=consumeRunEvent(view,event)
    assert.equal(view.publicTextParts?.length,['unrelated-source','commentary-source'].includes(scenario)?2:1)
    assert.equal(view.publicTextParts.at(-1)?.text,finalBody)
    const results=await pool.query('SELECT id FROM lingxios.agent_results WHERE work_id=$1',[identity.runId])
    const commits=page.events.filter(event=>event.kind==='response.committed')
    if(scenario==='commit-ack-loss'){
      if(scenario==='commit-ack-loss'){assert.equal(injected,true);assert.equal(replayed,true)}
      assert.equal(results.rows.length,1);assert.equal(commits.length,1)
      assert.equal(view.publicTextParts[0]?.acceptedResultId,state.run.resultId)
      assert.equal(commits[0]?.data['publicTextPartId'],view.publicTextParts[0]?.partId)
    }else{
      if(scenario==='commit-failure')assert.equal(injected,true)
      assert.equal(results.rows.length,0);assert.equal(commits.length,0);assert.equal(state.message,null)
      assert.ok(view.publicTextParts.every(part=>part.acceptedResultId===null),'unaccepted history remains visible even after an ended event')
    }
  }finally{await worker.stop();await app.stop();await db.close();await rm(directory,{recursive:true,force:true})}
})
