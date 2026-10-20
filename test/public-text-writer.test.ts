import assert from 'node:assert/strict'
import { it } from 'node:test'
import { PublicTextWriter, PublicTextPublicationError } from '../src/runtime/public-text.js'
import type { RunEvent } from '../src/protocol/types.js'
import { modelFailure } from '../src/model/recovery.js'
const identity={version:1 as const,requestVersion:1,fence:1,attemptId:'call',partId:'part',partIndex:0}
type Event=Omit<RunEvent,'runId'|'seq'>

it('first chunk waits for durable acknowledgement; later chunks coalesce within the time bound',async()=>{
  let release!:()=>void,entered!:()=>void,second!:()=>void
  const ack=new Promise<void>(resolve=>{release=resolve}),seen=new Promise<void>(resolve=>{entered=resolve}),later=new Promise<void>(resolve=>{second=resolve})
  const committed:Event[]=[]
  const writer=new PublicTextWriter(identity,async event=>{if(!committed.length){entered();await ack}committed.push(event);if(committed.length===2)second()},new AbortController().signal)
  let finished=false
  const pending=writer.push('first').then(()=>{finished=true})
  try{
    await seen;assert.equal(finished,false);assert.equal(committed.length,0)
    release();await pending;assert.equal(committed.length,1)
    await writer.push('coalesced');assert.equal(committed.length,1)
    await Promise.race([later,new Promise((_,reject)=>setTimeout(()=>reject(new Error('coalescing deadline exceeded')),500))])
    assert.equal(committed[1]?.data['text'],'coalesced')
    await writer.end('tool');assert.equal(committed.at(-1)?.kind,'public.text.ended')
  }finally{release();writer.dispose()}
})
it('UTF-8 chunks stay bounded without splitting code points and large buffered input is rejected',async()=>{
  const committed:Event[]=[],writer=new PublicTextWriter(identity,async event=>{committed.push(event)},new AbortController().signal)
  const text='甲🙂'.repeat(2000)
  await writer.push(text);await writer.end('completed')
  const chunks=committed.filter(event=>event.kind==='public.text.delta').map(event=>String(event.data['text']))
  assert.ok(chunks.length>1);assert.ok(chunks.every(chunk=>Buffer.byteLength(chunk)<=4096));assert.equal(chunks.join(''),text)
  assert.ok(chunks.every(chunk=>!chunk.includes('\uFFFD')))
  const oversized=new PublicTextWriter(identity,async()=>assert.fail('oversized chunk must not publish'),new AbortController().signal)
  await assert.rejects(oversized.push('x'.repeat(65_537)),PublicTextPublicationError);oversized.dispose()
})
it('failed persistence is nonretryable, exposes no failed buffer, and does not poison the next writer',async()=>{
  const events:Event[]=[],writer=new PublicTextWriter(identity,async()=>{throw new Error('synthetic write failure')},new AbortController().signal)
  await assert.rejects(writer.push('uncommitted'),error=>error instanceof PublicTextPublicationError&&!modelFailure(error).retryable)
  await assert.rejects(writer.push('more'),PublicTextPublicationError)
  await assert.rejects(writer.end('completed'),PublicTextPublicationError);writer.dispose()
  const next=new PublicTextWriter({...identity,attemptId:'next',partId:'next'},async event=>{events.push(event)},new AbortController().signal)
  await next.push('next request');await next.end('completed')
  assert.equal(events.filter(event=>event.kind==='public.text.delta').map(event=>event.data['text']).join(''),'next request')
})
it('cancellation drops only the unpublished coalescing buffer and leaves no timer work',async()=>{
  const stop=new AbortController(),events:Event[]=[],writer=new PublicTextWriter(identity,async event=>{events.push(event)},stop.signal)
  await writer.push('committed');await writer.push('not yet committed');stop.abort()
  await writer.end('cancelled');writer.dispose()
  await new Promise(resolve=>setTimeout(resolve,70))
  assert.equal(events.length,1);assert.equal(events[0]?.data['text'],'committed')
})
