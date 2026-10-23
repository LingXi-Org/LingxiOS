// Synthetic only. Run the same file against separately built baseline/candidate
// runtime roots. No provider network, browser, production or credential access.
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const root=resolve(process.argv[2]??'.'),label=process.argv[3],repetitions=Number(process.argv[4]??3)
if(!['baseline','candidate'].includes(label)||!Number.isInteger(repetitions)||repetitions<1||repetitions>5)throw Error('Usage: node measure-protocol-experience.mjs RUNTIME_ROOT baseline|candidate [1..5]')
assert.equal(execFileSync('git',['diff','HEAD','--','src'],{cwd:root,encoding:'utf8'}),'','runtime source must match its reported commit')
const harnessSha256=createHash('sha256').update(await readFile(process.argv[1])).digest('hex')
const require=createRequire(join(root,'package.json'))
const {PGlite}=require('@electric-sql/pglite')
const {createLingxiOS}=await import(pathToFileURL(join(root,'dist/src/index.js')).href)
const {createWorker}=await import(pathToFileURL(join(root,'dist/src/worker/index.js')).href)
const {OpenAIChatDriver}=await import(pathToFileURL(join(root,'dist/src/model/openai.js')).href)
const {nullLogger}=await import(pathToFileURL(join(root,'dist/src/logging.js')).href)
const expected='The answer is 42.',samples=[]
const frame=(content,finish=null,separator='\n\n')=>'data: '+JSON.stringify({choices:[{delta:{content},finish_reason:finish}],
  ...finish?{usage:{prompt_tokens:20,completion_tokens:10}}:{}})+separator

for(const scenario of ['normal','mixed-sse','empty-answer'])for(let repetition=1;repetition<=repetitions;repetition++){
  const db=new PGlite(),directory=await mkdtemp(join(tmpdir(),'protocol-experience-'))
  await db.exec(await readFile(join(root,'db/schema.sql'),'utf8'))
  let tail=Promise.resolve(),wire=0,firstUseful=null,lastAnswer=null,commentary=0,started=0
  const acquire=async()=>{let release;const prior=tail;tail=new Promise(resolve=>{release=resolve});await prior;return release}
  const query=async(sql,params)=>{const result=await db.query(sql,params);return {rows:result.rows,rowCount:result.affectedRows??result.rows.length}}
  const pool={async query(sql,params){const release=await acquire();try{return await query(sql,params)}finally{release()}},async connect(){return {query,release:await acquire()}}}
  const identity={runId:`${scenario}-${repetition}`,tenantId:'fixture-tenant',principalId:'fixture-user',agentId:'fixture-agent',sessionId:'fixture-room'}
  const app=await createLingxiOS({database:pool,logger:nullLogger,homesRoot:directory,realtime:{allowDraft:()=>false,allowPublicText:()=>true}})
  const driver=new OpenAIChatDriver('experience-'+scenario,{apiKey:'synthetic',maxAttempts:1,publicTextProtocol:'purpose-json-v1',
    recovery:{maxAttempts:1,totalTimeoutMs:5000},fetchImpl:async(_url,init)=>{
      const request=JSON.parse(String(init.body));assert.equal(request.stream,true,'normal short text needs no hidden auxiliary fixture')
      wire++
      const correction=request.messages.filter(message=>message.role==='user').at(-1)?.content??''
      const repaired=correction.includes('purpose-json-v1')&&correction.includes('answer')&&correction.includes('nonempty')
      return new Response(new ReadableStream({async start(controller){
        const send=value=>controller.enqueue(new TextEncoder().encode(value))
        // Pacing is identical for both source revisions, including failed turns.
        await delay(25)
        if(scenario==='empty-answer'&&!repaired)send(frame('{"commentary":"Checking","answer":""}'))
        else if(scenario==='mixed-sse')send(frame('{"commentary":"Checking","answer":"',null,'\r\n\n')+frame(expected+'"}'))
        else send(frame('{"commentary":"Checking","answer":"')+frame(expected+'"}'))
        await delay(25)
        send(frame('','stop')+'data: [DONE]\n\n');controller.close()
      }}))
    }})
  // Preserve this single-attempt driver so the wrapper observes publication only
  // after the real runtime callback has completed its durable append.
  driver.singleAttempt=()=>driver
  const original=driver.run.bind(driver)
  driver.run=request=>{
    let answer=''
    return original({...request,onTextDelta:async(text,metadata)=>{
      await request.onTextDelta?.(text,metadata)
      if(metadata?.purpose==='commentary'){commentary+=text.length;return}
      if(metadata?.purpose!=='answer'||!text)return
      answer+=text;lastAnswer=performance.now()-started
      if(answer.includes(expected)&&firstUseful===null)firstUseful=lastAnswer
    }})
  }
  const worker=createWorker({controlPlane:app,model:driver,logger:nullLogger,kernel:{homesRoot:directory},worker:{id:'experience',healthPort:0},
    modelBudget:{maxModelCalls:8,maxTokens:200000,wallClockMs:10000,inputCostMicrosPerMillion:1,outputCostMicrosPerMillion:1}})
  try{
    await app.enqueue({id:identity.runId,...identity,text:'Reply exactly: The answer is 42.',mode:'chat',deliveryMode:'text',codeExecution:'disabled'})
    started=performance.now();await worker.runNext();const completed=performance.now()-started
    const state=await app.readRunState(identity),page=await app.readEvents(identity),terminal=await app.readTerminal(identity)
    const committed=page.events.some(event=>event.kind==='response.committed')
    const fullDelivery=state?.run.status==='succeeded'&&state.message?.body===expected&&committed
    const shouldSucceed=scenario==='normal'||label==='candidate'
    assert.equal(fullDelivery,shouldSucceed,'do not relabel a partial or failed answer complete')
    assert.equal(wire,scenario==='normal'||scenario==='mixed-sse'&&label==='candidate'?1:label==='candidate'?2:3)
    assert.equal(firstUseful===null,!shouldSucceed)
    const ledger=await pool.query('SELECT observation FROM lingxios.agent_model_budget_calls WHERE work_id=$1',[identity.runId])
    assert.equal(ledger.rows.length,wire);assert.ok(ledger.rows.every(row=>row.observation))
    const round=n=>n===null?null:Math.round(n*1000)/1000
    samples.push({scenario,repetition,firstUsefulAnswerMs:round(firstUseful),lastAnswerMs:round(lastAnswer),nativeCompletedMs:round(completed),
      lastAnswerToNativeCompleteMs:lastAnswer===null?null:round(completed-lastAnswer),fullDelivery,generationCalls:wire,settledCalls:ledger.rows.length,
      status:state.run.status,terminalReason:terminal?.feedback.reason??null,commentaryCharactersExcluded:commentary})
  }finally{await worker.stop();await app.stop();await db.close();await rm(directory,{recursive:true,force:true})}
}
console.log(JSON.stringify({format:'synthetic-protocol-experience/v1',label,source:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
  harnessSha256,node:process.version,repetitions,pacingMs:[25,25],scope:'native durable answer and terminal completion; excludes browser and external IM transport',samples},null,2))
