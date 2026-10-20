import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS } from '../src/index.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import { nullLogger } from '../src/logging.js'
import { consumePublicTextAttempts, consumeRunEvent, consumeRunState, createRunView } from '../src/ui/index.js'

it('SIGKILL after an acknowledged public chunk preserves history when a fresh HTTP worker reclaims the run',async()=>{
  const db=new PGlite(),directory=await mkdtemp(join(tmpdir(),'public-text-process-'))
  await db.exec(await readFile(new URL('../../db/schema.sql',import.meta.url),'utf8'))
  let tail=Promise.resolve(),wire=0
  const acquire=async()=>{let release!:()=>void;const prior=tail;tail=new Promise<void>(resolve=>{release=resolve});await prior;return release}
  const query:SqlPool['query']=async(sql,params)=>{const r=await db.query<Record<string,unknown>>(sql,params);return {rows:r.rows,rowCount:r.affectedRows??r.rows.length}}
  const pool:SqlPool={async query(sql,params){const release=await acquire();try{return await query(sql,params)}finally{release()}},async connect(){return {query,release:await acquire()}}}
  const app=await createLingxiOS({database:pool,logger:nullLogger,homesRoot:directory,realtime:{allowDraft:()=>false,allowPublicText:()=>true}})
  const provider=createServer((request,response)=>{
    request.resume();request.once('end',()=>{
      const first=++wire===1
      response.writeHead(200,{'content-type':'text/event-stream'})
      response.write(`data: ${JSON.stringify({choices:[{delta:{content:first?'Published before crash.':'Recovered answer.'},...first?{}:{finish_reason:'stop'}}],...first?{}:{usage:{prompt_tokens:10,completion_tokens:5}}})}\n\n`)
      if(!first)response.end('data: [DONE]\n\n')
      // First response deliberately stays open until only its test worker is SIGKILLed.
    })
  })
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve))
  const providerPort=(provider.address() as {port:number}).port,controlPort=await app.listenControlPlane({port:0,serviceToken:'synthetic-worker-token'})
  const script=`import { createWorker } from ${JSON.stringify(new URL('../src/worker/index.js',import.meta.url).href)};
    import { nullLogger } from ${JSON.stringify(new URL('../src/logging.js',import.meta.url).href)};
    const input=JSON.parse(process.argv[1]);const worker=createWorker({...input,logger:nullLogger});
    try{await worker.runNext()}finally{await worker.stop()}`
  const children:Array<ReturnType<typeof spawn>>=[]
  const start=()=>{
    const child=spawn(process.execPath,['--input-type=module','-e',script,JSON.stringify({
      controlPlane:{url:`http://127.0.0.1:${controlPort}`,serviceToken:'synthetic-worker-token'},
      model:{id:'process-fixture',apiKey:'synthetic-provider-key',baseUrl:`http://127.0.0.1:${providerPort}/v1`,requestTimeoutMs:15_000},
      kernel:{homesRoot:directory},worker:{healthPort:0}})],{stdio:['ignore','ignore','pipe']})
    children.push(child);let stderr='';child.stderr?.on('data',chunk=>{stderr+=String(chunk).slice(0,4096)})
    const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})))
    return {child,exited,stderr:()=>stderr}
  }
  const identity={runId:'crashed',tenantId:'tenant',principalId:'human',agentId:'agent',sessionId:'room'}
  try{
    await app.enqueue({id:identity.runId,...identity,text:'Say hello.',mode:'chat',codeExecution:'disabled'})
    const first=start(),until=Date.now()+10_000
    while(!(await app.readEvents(identity)).events.some(event=>event.kind==='public.text.delta')){
      assert.ok(Date.now()<until,'first chunk was not durably acknowledged before crash');await delay(10)
    }
    first.child.kill('SIGKILL');assert.equal((await first.exited).signal,'SIGKILL')
    assert.equal((await app.readEvents(identity)).events.some(event=>event.kind==='public.text.ended'),false)
    await pool.query("UPDATE lingxios.agent_work_items SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[identity.runId])
    await pool.query("UPDATE lingxios.agent_os_session_leases SET expires_at=NOW()-INTERVAL '1 second' WHERE work_id=$1",[identity.runId])
    const replacement=start()
    const exited=await Promise.race([replacement.exited,delay(10_000).then(()=>{throw new Error('replacement worker did not finish')})])
    assert.equal(exited.code,0,replacement.stderr())
    const state=await app.readRunState(identity),page=await app.readEvents(identity)
    assert.ok(state);assert.equal(state.run.fence,2);assert.equal(state.message?.body,'Recovered answer.')
    let replay=consumeRunState(createRunView(identity.runId),state)
    replay=consumePublicTextAttempts(replay,page.publicTextAttempts??[])
    for(const event of page.events)replay=consumeRunEvent(replay,event)
    assert.deepEqual(replay.publicTextParts?.map(part=>[part.text,part.reason]),[['Published before crash.','interrupted'],['Recovered answer.','completed']])
    assert.equal(wire,2)
  }finally{
    for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')
    provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()))
    await app.stop();await db.close();await rm(directory,{recursive:true,force:true})
  }
})
