import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS } from '../src/index.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import type { RunEvent, WorkItem } from '../src/protocol/types.js'
import { nullLogger } from '../src/logging.js'
import { consumePublicTextAttempts, consumeRunEvent, consumeRunState, consumeRunStreamEvent, createRunView } from '../src/ui/index.js'

async function fixture() {
  const db=new PGlite(), directory=await mkdtemp(join(tmpdir(),'public-text-storage-'))
  await db.exec(await readFile(new URL('../../db/schema.sql',import.meta.url),'utf8'))
  let tail=Promise.resolve(), failAppend=false, allow=true, authorizations=0
  const acquire=async()=>{let release!:()=>void;const prior=tail;tail=new Promise<void>(resolve=>{release=resolve});await prior;return release}
  const query:SqlPool['query']=async(sql,params)=>{
    if(failAppend&&sql.includes('INSERT INTO lingxios.agent_run_events'))throw new Error('synthetic event store unavailable')
    const r=await db.query<Record<string,unknown>>(sql,params);return {rows:r.rows,rowCount:r.affectedRows??r.rows.length}
  }
  const pool:SqlPool={async query(sql,params){const release=await acquire();try{return await query(sql,params)}finally{release()}},
    async connect(){return {query,release:await acquire()}}}
  const realtime={allowPublicText:async(_work:Omit<WorkItem,'leaseToken'>,_version:number,context:import('../src/index.js').PublicTextAuthorizationContext)=>{
    authorizations++;assert.ok(context.signal instanceof AbortSignal);assert.ok(context.deadlineMs>Date.now())
    await context.database.query('SELECT 1');return allow
  }}
  const apps:Awaited<ReturnType<typeof createLingxiOS>>[]=[]
  const open=async()=>{const app=await createLingxiOS({database:pool,logger:nullLogger,realtime,homesRoot:directory});apps.push(app);return app}
  const app=await open(),host=app.connectWorker({workerId:'storage-fixture',workKinds:['turn']})
  const identity={runId:'run',tenantId:'tenant',principalId:'human',agentId:'agent',sessionId:'room'}
  await app.enqueue({id:identity.runId,...identity,text:'synthetic request',mode:'chat'})
  const work=(await host.claimWork())!
  const delta=(seq:number,text:string,extras:Record<string,unknown>={}):RunEvent=>({runId:work.id,seq,kind:'public.text.delta',stage:'delta',visibility:'user',data:{
    version:1,requestVersion:1,fence:1,attemptId:'attempt-1',partId:'part-1',partIndex:0,chunkIndex:seq-1,text,...extras}})
  return {app,host,work,identity,delta,pool,open,db,setAllowed:(value:boolean)=>{allow=value},setFail:(value:boolean)=>{failAppend=value},
    authorizations:()=>authorizations,async close(){for(const app of apps)await app.stop();await db.close();await rm(directory,{recursive:true,force:true})}}
}

it('current policy, revision and event identity gate atomic publication and identical ACK replay',async()=>{
  const f=await fixture()
  try{
    await f.host.emitEvent(f.work,f.delta(1,'committed'))
    await f.host.emitEvent(f.work,f.delta(1,'committed')) // Lost ACK replay does not append twice.
    await assert.rejects(f.host.emitEvent(f.work,f.delta(1,'different')),/conflicting/)
    await assert.rejects(f.host.emitEvent(f.work,f.delta(2,'gap',{chunkIndex:5})),/sequence/)
    await assert.rejects(f.host.emitEvent(f.work,f.delta(2,'hidden',{reasoning:'private'})),/invalid/)
    f.setAllowed(false)
    await assert.rejects(f.host.emitEvent(f.work,f.delta(2,'revoked')),/authorized/)
    f.setAllowed(true);f.setFail(true)
    await assert.rejects(f.host.emitEvent(f.work,f.delta(2,'not committed')),/synthetic/)
    f.setFail(false)
    assert.deepEqual((await f.app.readEvents(f.identity)).events.map(event=>event.data['text']),['committed'])
    await f.app.revise(f.identity,'revised request')
    await assert.rejects(f.host.emitEvent(f.work,f.delta(2,'old request')),/current/)
    assert.deepEqual((await f.app.readEvents({...f.identity,principalId:'other'})).events,[])
    assert.ok(f.authorizations()>=4)
    const outbox=await f.pool.query('SELECT COUNT(*) AS count FROM lingxios.agent_run_events WHERE run_id=$1',[f.work.id])
    assert.equal(Number(outbox.rows[0]?.['count']),1)
  }finally{await f.close()}
})

it('cancelled prefix survives process replacement without any runtime finally or ended event',async()=>{
  const f=await fixture()
  try{
    await f.host.emitEvent(f.work,f.delta(1,'already public'))
    await f.app.cancel(f.identity)
    await assert.rejects(f.host.emitEvent(f.work,f.delta(2,'after cancellation')),/current/)
    // No AgentRuntime or finally ran. A new public application reads the durable attempt state.
    const reader=await f.open(),state=await reader.readRunState(f.identity),page=await reader.readEvents(f.identity)
    assert.ok(state);assert.deepEqual(page.publicTextAttempts,[{fence:1,reason:'cancelled'}])
    let view=consumeRunState(createRunView(f.work.id),state)
    view=consumePublicTextAttempts(view,page.publicTextAttempts??[])
    for(const event of page.events)view=consumeRunEvent(view,event)
    assert.equal(view.publicTextParts?.[0]?.text,'already public')
    assert.equal(view.publicTextParts?.[0]?.reason,'cancelled')
    assert.equal(view.publicTextParts?.[0]?.endedSeq,null)
    assert.equal(page.events.some(event=>event.kind==='public.text.ended'),false)
  }finally{await f.close()}
})

it('a reclaimed fence preserves the crashed prefix and its terminal state across 100-event pages',async()=>{
  const f=await fixture()
  try{
    // 81 independent parts deliberately span the existing 100-event page boundary.
    for(let i=0;i<81;i++){
      await f.host.emitEvent(f.work,f.delta(i*2+1,`part ${i}`,{partId:`part-${i}`,attemptId:`attempt-${i}`,chunkIndex:0}))
      if(i<80)await f.host.emitEvent(f.work,{...f.delta(i*2+2,''),kind:'public.text.ended',stage:'completed',data:{
        version:1,requestVersion:1,fence:1,partId:`part-${i}`,attemptId:`attempt-${i}`,partIndex:0,chunkCount:1,reason:'tool'}})
    }
    // Model process disappeared. Expire only this isolated fixture lease, then use the public worker claim.
    await f.pool.query("UPDATE lingxios.agent_work_items SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[f.work.id])
    await f.pool.query("UPDATE lingxios.agent_os_session_leases SET expires_at=NOW()-INTERVAL '1 second' WHERE work_id=$1",[f.work.id])
    const restarted=f.app.connectWorker({workerId:'replacement',workKinds:['turn']}),next=(await restarted.claimWork())!
    assert.equal(next.fence,2)
    await assert.rejects(f.host.emitEvent(f.work,f.delta(162,'stale')),/lease/)
    await restarted.emitEvent(next,{...f.delta(100001,'replacement'),data:{version:1,requestVersion:1,fence:2,attemptId:'replacement',partId:'replacement',partIndex:0,chunkIndex:0,text:'replacement'}})
    await restarted.completeWork(next,{status:'failed',error:'synthetic failure'})
    const reader=await f.open(),state=await reader.readRunState(f.identity)
    assert.ok(state)
    let view=consumeRunState(createRunView(f.work.id),state),cursor=0,pages=0,metadata=0
    while(true){const page=await reader.readEvents(f.identity,cursor);pages++;assert.ok(page.events.length<=100);metadata=Math.max(metadata,page.publicTextAttempts?.length??0)
      view=consumePublicTextAttempts(view,page.publicTextAttempts??[])
      for(const event of page.events)view=consumeRunEvent(view,event)
      if(page.events.length<100)break;cursor=page.nextSeq
    }
    assert.equal(pages,2);assert.ok(metadata<=2)
    assert.equal(view.publicTextParts?.length,82)
    assert.equal(view.publicTextParts?.[0]?.reason,'tool')
    assert.equal(view.publicTextParts?.[80]?.reason,'interrupted')
    assert.equal(view.publicTextParts?.[81]?.reason,'failed')
    assert.equal(view.message,null)
    const response=await reader.streamRun(f.identity),wire=await response.text()
    let streamed=createRunView(f.work.id)
    for(const frame of wire.split('\n\n')){
      const line=frame.split('\n').find(line=>line.startsWith('data: '))
      if(line)streamed=consumeRunStreamEvent(streamed,JSON.parse(line.slice(6)))
    }
    assert.deepEqual(streamed.publicTextParts,view.publicTextParts)
  }finally{await f.close()}
})

it('native IM speak and frozen audience authorization are rechecked before every append and read',async()=>{
  const f=await fixture()
  try{
    await f.host.completeWork(f.work,{status:'failed',error:'fixture complete'})
    const policy:import('../src/collaboration/types.js').ConversationPolicy={tenantId:'tenant',conversationId:'im-room',version:1,kind:'group',
      owner:{kind:'participant',id:'human'},defaultAgentId:'agent',participants:[
        {id:'human',kind:'human',capabilities:['read','execute']},{id:'reader',kind:'human',capabilities:['read','execute']},
        {id:'agent',kind:'agent',capabilities:['read','execute','speak']}]}
    await f.app.conversations.sync(policy)
    const identity=(await f.app.conversations.ingest({tenantId:'tenant',conversationId:'im-room',policyVersion:1,messageId:'im-message',version:1,
      author:{id:'human',kind:'human'},text:'Synthetic message'})).runs[0]!
    const work=(await f.host.claimWork())!
    assert.equal(work.id,identity.runId)
    const delta={...f.delta(1,'public to frozen audience'),runId:work.id}
    await f.host.emitEvent(work,delta)
    assert.equal((await f.app.readEvents({...identity,principalId:'reader'})).events.length,1)
    await f.app.conversations.sync({...policy,version:2,participants:policy.participants.map(participant=>participant.id==='agent'
      ?{...participant,capabilities:['read','execute']}:participant)})
    const before=f.authorizations()
    await assert.rejects(f.host.emitEvent(work,{...delta,seq:2,data:{...delta.data,chunkIndex:1,text:'revoked speak'}}),/speak/)
    assert.equal(f.authorizations(),before,'native policy must reject before product policy')
    await f.app.conversations.sync({...policy,version:3,participants:policy.participants.filter(participant=>participant.id!=='reader')})
    await assert.rejects(f.app.readEvents({...identity,principalId:'reader'}),/read/)
    await assert.rejects(f.host.emitEvent(work,{...delta,seq:2,data:{...delta.data,chunkIndex:1,text:'changed audience'}}),/read/)
    assert.equal((await f.app.readEvents(identity)).events.length,1)
  }finally{await f.close()}
})
