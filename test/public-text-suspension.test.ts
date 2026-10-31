import assert from 'node:assert/strict'
import {it} from 'node:test'
import {PublicTextAttemptWriter,PublicTextPublicationError,PublicTextSafetyError} from '../src/runtime/public-text.js'
import type {RunEvent} from '../src/protocol/types.js'
type Event=Omit<RunEvent,'runId'|'seq'>
const identity={version:3 as const,requestVersion:1,fence:1,attemptId:'model:6',partId:'model:6',partIndex:1,messageId:'synthetic'}
function fixture(rejectSeal=false,rejectFinal=false){
 const events:Event[]=[]
 const writer=new PublicTextAttemptWriter(identity,async event=>{
  if(event.kind==='public.text.sealed'){
   assert.equal(events.at(-1)?.data['reason'],'completed','storage only accepts a completed answer')
   if(rejectSeal)throw Error('synthetic storage rejection')
  }
  events.push(event)
 },new AbortController().signal,({text,isFinal})=>({safeThrough:isFinal&&!rejectFinal?text.length:Math.min(3,text.length),...(isFinal&&rejectFinal?{reject:'unsafe_content' as const}:{})}),'purpose-json-v3')
 return {writer,events}
}
async function hold(writer:PublicTextAttemptWriter){
 await writer.begin({kind:'append',supersedes:[]})
 await writer.push('OK ',{purpose:'answer'})
 await writer.push('safe suffix',{purpose:'answer'})
 await new Promise(resolve=>setTimeout(resolve,1150))
}
it('a bounded v3 answer pause resumes only at safe EOF and seals the exact durable body',async()=>{
 const {writer,events}=fixture()
 try{
  await hold(writer)
  await writer.finish('OK safe suffix');await writer.end('completed');await writer.seal('OK safe suffix')
  assert.equal(events.filter(e=>e.kind==='public.text.ended').length,1)
  assert.equal(events.at(-1)?.kind,'public.text.sealed')
  assert.equal(events.filter(e=>e.kind==='public.text.delta').map(e=>e.data['text']).join(''),'OK safe suffix')
 }finally{writer.dispose()}
})
it('a resumed v3 answer cannot rewrite its acknowledged prefix',async()=>{
 const {writer,events}=fixture()
 try{await hold(writer);await assert.rejects(writer.finish('NO changed prefix'),PublicTextSafetyError);assert.ok(!events.some(e=>e.kind==='public.text.sealed'))}finally{writer.dispose()}
})
it('real persistence rejection after resumed EOF remains a nonrecoverable seal failure',async()=>{
 const {writer,events}=fixture(true)
 try{await hold(writer);await writer.finish('OK safe suffix');await writer.end('completed');await assert.rejects(writer.seal('OK safe suffix'),e=>e instanceof PublicTextPublicationError&&e.stage==='seal'&&e.rejection==='persistence_rejected');assert.ok(!events.some(e=>e.kind==='public.text.sealed'))}finally{writer.dispose()}
})

it('EOF rejection never publishes the held suffix or a successful seal',async()=>{
 const {writer,events}=fixture(false,true)
 try{await hold(writer);await assert.rejects(writer.finish('OK safe suffix'),PublicTextSafetyError);assert.equal(events.filter(e=>e.kind==='public.text.delta').map(e=>e.data['text']).join(''),'OK ');assert.ok(!events.some(e=>e.kind==='public.text.sealed'))}finally{writer.dispose()}
})
it('resumed EOF remains within the received-byte bound',async()=>{
 const {writer,events}=fixture()
 try{await hold(writer);await assert.rejects(writer.finish('OK '+'x'.repeat(200000)),PublicTextSafetyError);assert.ok(!events.some(e=>e.kind==='public.text.sealed'))}finally{writer.dispose()}
})
it('EOF waits for an in-flight acknowledged prefix when the held timer pauses publication',async()=>{
 const events:Event[]=[];let release!:()=>void,entered!:()=>void
 const gate=new Promise<void>(r=>{release=r}),seen=new Promise<void>(r=>{entered=r})
 const writer=new PublicTextAttemptWriter(identity,async event=>{
  if(event.kind==='public.text.delta'&&event.data['chunkIndex']===1){entered();await gate}
  events.push(event)
 },new AbortController().signal,({text,isFinal})=>({safeThrough:isFinal?text.length:text.length>=4096?4:Math.min(3,text.length)}),'purpose-json-v3')
 const text='OK held'+'x'.repeat(4096)
 try{
  await writer.begin({kind:'append',supersedes:[]});await writer.push('OK ',{purpose:'answer'});await writer.push('held',{purpose:'answer'})
  await new Promise(r=>setTimeout(r,80))
  const pending=writer.push('x'.repeat(4096),{purpose:'answer'});await seen
  await new Promise(r=>setTimeout(r,1100))
  const finishing=writer.finish(text);release();await pending;await finishing;await writer.end('completed');await writer.seal(text)
  assert.equal(events.filter(e=>e.kind==='public.text.delta').map(e=>e.data['text']).join(''),text)
 }finally{release();writer.dispose()}
})
