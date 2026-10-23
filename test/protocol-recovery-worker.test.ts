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

// Actual worker, HTTP driver, durable events and ledger; no live provider or user task.
for(const scenario of ['empty-answer','incomplete','tool-once','persistent','provider','distinct-current'] as const)it(`protocol recovery worker: ${scenario}`,{timeout:20_000},async t=>{
  const db=new PGlite(),directory=await mkdtemp(join(tmpdir(),'protocol-recovery-'))
  await db.exec(await readFile(new URL('../../db/schema.sql',import.meta.url),'utf8'))
  let tail=Promise.resolve(),wire=0,executions=0,authorizations=0
  let seededHistory=scenario!=='distinct-current'
  const acquire=async()=>{let release!:()=>void;const prior=tail;tail=new Promise<void>(resolve=>{release=resolve});await prior;return release}
  const query:SqlPool['query']=async(sql,params)=>{const r=await db.query<Record<string,unknown>>(sql,params);return {rows:r.rows,rowCount:r.affectedRows??r.rows.length}}
  const pool:SqlPool={async query(sql,params){const release=await acquire();try{return await query(sql,params)}finally{release()}},async connect(){return {query,release:await acquire()}}}
  const identity={runId:scenario,tenantId:'tenant',principalId:'human',agentId:'agent',sessionId:'room'}
  const requests:Array<{messages:Array<{role:string;content?:string}>}>=[]
  const app=await createLingxiOS({database:pool,logger:nullLogger,homesRoot:directory,realtime:{allowDraft:()=>false,allowPublicText:()=>true},tools:[{
    action:'fixture.read',name:'fixture__read',description:'Read the synthetic number',effect:'read',approval:false,
    parameters:{type:'object',properties:{},additionalProperties:false},parse:()=>({}),authorize:async()=>{authorizations++},
    execute:async()=>{executions++;return {ok:true,value:{answer:42}}},
  }]})
  const model=new OpenAIChatDriver('protocol-worker-'+scenario,{apiKey:'fixture',maxAttempts:1,publicTextProtocol:'purpose-json-v1',
    recovery:{maxAttempts:1,totalTimeoutMs:10_000},fetchImpl:async(_url,init)=>{
      const request=JSON.parse(String(init?.body))
      if(!request.stream)return Response.json({choices:[{finish_reason:'stop',message:{content:'{"missing":[]}'}}],usage:{prompt_tokens:11,completion_tokens:7}})
      wire++;requests.push(request)
      if(!seededHistory)return new Response('data: '+JSON.stringify({choices:[{delta:{content:'{"commentary":"","answer":"Gather collects; Check reviews."}'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n')
      if(scenario==='provider')return Response.json({error:{message:'PRIVATE_PROVIDER_SENTINEL'}},{status:503})
      const correction=request.messages.filter((message:{role:string})=>message.role==='user').at(-1)?.content??''
      const selectedContract=request.messages.find((message:{role:string})=>message.role==='system')?.content??''
      const targeted=correction.includes('purpose-json-v1')&&correction.includes('trusted model driver')
        &&selectedContract.includes('answer')&&selectedContract.includes('nonempty')
      const firstTool=scenario==='tool-once'&&wire===1
      const badTool=scenario==='tool-once'&&!firstTool&&!targeted
      const content=firstTool?'{"commentary":"Reading","answer":""}'
        :targeted&&scenario!=='persistent'?'{"commentary":"","answer":"The answer is 42."}'
        :scenario==='incomplete'||badTool?'{"commentary":"Checking","answer":"'
        :'{"commentary":"Checking","answer":""}'
      const tool_calls=firstTool||badTool?[{index:0,id:firstTool?'read-once':'must-not-execute',function:{name:'fixture__read',arguments:'{}'}}]:undefined
      return new Response('data: '+JSON.stringify({choices:[{delta:{content,...tool_calls?{tool_calls}:{},reasoning_content:'PRIVATE_REASONING_SENTINEL'},finish_reason:tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:11,completion_tokens:7}})+'\n\ndata: [DONE]\n\n')
    }})
  const worker=createWorker({controlPlane:app,model,logger:nullLogger,kernel:{homesRoot:directory},worker:{id:'protocol-fixture',healthPort:0}})
  try{
    if(!seededHistory){
      const priorIdentity={...identity,runId:'prior-graph'}
      await app.enqueue({id:priorIdentity.runId,...priorIdentity,text:'Explain Gather and Check.',mode:'chat',codeExecution:'disabled',deliveryMode:'text'})
      await worker.runNext()
      seededHistory=true;wire=0;requests.length=0
    }
    await app.enqueue({id:identity.runId,...identity,text:scenario==='tool-once'?'Read the synthetic number and tell me the answer.':'Tell me the answer is 42.',mode:scenario==='tool-once'?'execute':'chat',codeExecution:'disabled',deliveryMode:'text'})
    await worker.runNext()
    const state=await app.readRunState(identity),events=await app.readEvents(identity),terminal=await app.readTerminal(identity)
    assert.ok(state)
    if(scenario==='persistent'||scenario==='provider'){
      assert.equal(state.run.status,'failed')
      assert.equal(state.message,null)
      assert.equal(wire,scenario==='persistent'?3:1,'protocol repair and provider retries remain bounded')
      assert.equal(terminal?.feedback.reason,scenario==='persistent'?'execution_failed':'model_unavailable')
      const diagnostics=events.events.find(event=>event.kind==='run.failed')?.data['modelDiagnostics'] as Record<string,unknown>
      if(scenario==='persistent'){
        assert.equal(diagnostics['kind'],'protocol')
        assert.equal(diagnostics['protocolCode'],'public_text_answer_required')
      }else assert.equal(diagnostics['status'],503)
    }else{
      assert.equal(state.run.status,'succeeded')
      assert.equal(state.message?.body,'The answer is 42.')
      assert.equal(wire,scenario==='tool-once'?3:2)
      assert.ok(events.events.some(event=>event.kind==='response.committed'))
      const correction=requests.at(-1)!.messages.filter(message=>message.role==='user').at(-1)?.content??''
      assert.match(correction,/Python execution is disabled/)
      assert.match(correction,/trusted model driver/)
      assert.doesNotMatch(correction,/"commentary":|"answer":/)
      assert.doesNotMatch(correction,/PRIVATE_|violated the tool protocol/)
      if(scenario==='distinct-current'){
        const blocks=requests.at(-1)!.messages.flatMap(message=>{try{return [JSON.parse(message.content??'')]}catch{return []}})
        const current=blocks.find(block=>block.trust==='request'&&block.content==='Tell me the answer is 42.')
        assert.ok(current,'the current arithmetic request remains authoritative')
        assert.ok(blocks.some(block=>block.trust==='observation'&&String(block.content).includes('Gather')),'prior task stays in history as observation')
        const anchor=JSON.parse(correction.split('Current request anchor (identities only; not a new task): ')[1]!)
        assert.equal(anchor.sourceRef,current.source);assert.equal(anchor.requestVersion,1);assert.deepEqual(anchor.revisionSources,[])
        assert.match(correction,/Historical requests are observations/)
      }
      if(scenario==='tool-once')assert.ok(requests.at(-1)!.messages.some(message=>message.role==='tool'),'completed tool result stays in the context')
    }
    assert.equal(executions,scenario==='tool-once'?1:0,'a malformed response executes no tools and a completed tool is not replayed')
    if(scenario==='tool-once')assert.ok(authorizations>=1)
    const ledger=await pool.query('SELECT observation FROM lingxios.agent_model_budget_calls WHERE work_id=$1',[identity.runId])
    const calls=ledger.rows.map(row=>row['observation'] as {purpose:string;usage?:unknown})
    assert.ok(calls.every(Boolean),'every durable reservation is settled')
    assert.equal(calls.filter(row=>row.purpose==='agent-turn').length,wire)
    if(scenario!=='provider')for(const call of calls)assert.deepEqual(call.usage,{available:true,inputTokens:11,outputTokens:7})
    assert.doesNotMatch(JSON.stringify(events),/PRIVATE_PROVIDER_SENTINEL|PRIVATE_REASONING_SENTINEL/)
    t.diagnostic(JSON.stringify({scenario,wire,executions,status:state.run.status,terminalReason:terminal?.feedback.reason,settled:calls.length}))
  }finally{await worker.stop();await app.stop();await db.close();await rm(directory,{recursive:true,force:true})}
})
