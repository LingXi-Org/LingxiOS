import assert from 'node:assert/strict'
import { it } from 'node:test'
import { PublicTextWriter } from '../src/runtime/public-text.js'
import type { RunEvent } from '../src/protocol/types.js'
const identity={version:1 as const,requestVersion:1,fence:1,attemptId:'safety',partId:'safety',partIndex:0}
type Input=Readonly<{text:string;isFinal:boolean;approvedThrough:number}>
type Decision={safeThrough:number;reject?:'unsafe_content'|'unsupported_content'}
type Writer=PublicTextWriter&{finish(text?:string):Promise<void>}
const CandidateWriter=PublicTextWriter as unknown as new(part:typeof identity,emit:(event:Omit<RunEvent,'runId'|'seq'>)=>Promise<unknown>,signal:AbortSignal,assess:(input:Input)=>Decision)=>Writer
// This controlled policy exercises the runtime approval contract; product syntax lives in its own tests.
const markerPolicy=({text}:Input):Decision=>{
  const marker='<think>',found=text.indexOf(marker)
  if(found>=0)return {safeThrough:found,reject:'unsafe_content'}
  let withheld=0
  for(let size=1;size<marker.length;size++)if(text.endsWith(marker.slice(0,size)))withheld=size
  return {safeThrough:text.length-withheld}
}
const fixture=(assess:(input:Input)=>Decision)=>{const events:Array<Omit<RunEvent,'runId'|'seq'>>=[],stop=new AbortController()
  return {events,stop,writer:new CandidateWriter(identity,async event=>{events.push(event)},stop.signal,assess)}}
const published=(f:ReturnType<typeof fixture>)=>f.events.filter(event=>event.kind==='public.text.delta').map(event=>event.data['text']).join('')

it('approval holds every partial marker and rejects before any marked payload can be committed',async()=>{
  for(const chunks of [['<think>PRIVATE'],[...'<think>PRIVATE'],['safe prefix','<th','ink>PRIVATE']]){
    const f=fixture(markerPolicy)
    try{
      await assert.rejects(async()=>{for(const chunk of chunks)await f.writer.push(chunk);await f.writer.finish()},/public text/)
      await f.writer.end('failed')
      assert.equal(published(f),chunks[0]==='safe prefix'?'safe prefix':'')
      assert.ok(f.events.every(event=>event.data['reason']!=='completed'))
    }finally{f.writer.dispose()}
  }
})
it('a held EOF or thrown policy cannot flush unapproved content or expose the policy error',async()=>{
  for(const assess of [()=>({safeThrough:0}),()=>{throw new Error('PRIVATE_POLICY_ERROR')}]){
    const f=fixture(assess)
    try{
      await assert.rejects(async()=>{await f.writer.push('unapproved');await f.writer.finish()},error=>error instanceof Error&&!error.message.includes('PRIVATE_POLICY_ERROR'))
      assert.equal(published(f),'')
    }finally{f.writer.dispose()}
  }
})
it('approval offsets are monotonic, within bounds, and never split a Unicode surrogate pair',async()=>{
  for(const offset of [-1,0.5,100,1]){
    const f=fixture(()=>({safeThrough:offset}))
    try{await assert.rejects(f.writer.push('🙂'),/public text/);assert.equal(published(f),'')}finally{f.writer.dispose()}
  }
  let calls=0;const f=fixture(({text})=>({safeThrough:++calls===1?text.length:0}))
  try{await f.writer.push('safe');await f.writer.push(' suffix');await assert.rejects(f.writer.finish(),/public text/);assert.equal(published(f),'safe')}finally{f.writer.dispose()}
})
it('uncertain suffix timeout suspends publication without failing a later safe final answer',async()=>{
  const f=fixture(({text,isFinal})=>({safeThrough:isFinal?text.length:Math.min(text.length,4)}))
  try{
    await f.writer.push('safe');await f.writer.push(' uncertain')
    await new Promise(resolve=>setTimeout(resolve,1100))
    await f.writer.push(' but valid')
    await f.writer.finish('safe uncertain but valid');await f.writer.end('completed')
    assert.equal(published(f),'safe')
    assert.equal(f.events.at(-1)?.data['reason'],'interrupted')
  }finally{f.writer.dispose()}
})
it('cancellation and exhausted holding budget discard only unapproved suffixes',async()=>{
  const f=fixture(({isFinal,text})=>({safeThrough:isFinal?text.length:0}))
  try{await f.writer.push('x'.repeat(65_537));await f.writer.finish('safe full answer');await f.writer.end('completed');assert.equal(published(f),'')}finally{f.writer.dispose()}
  const cancelled=fixture(()=>({safeThrough:0}))
  try{await cancelled.writer.push('pending');cancelled.stop.abort();await cancelled.writer.end('cancelled');assert.equal(published(cancelled),'')}finally{cancelled.writer.dispose()}
})

it('invalid null, asynchronous and mutating policies fail closed without leaking exceptions',async()=>{
  for(const assess of [()=>undefined as unknown as Decision,()=>Promise.reject(new Error('PRIVATE_ASYNC')) as unknown as Decision,
    (input:Input)=>{Object.assign(input,{text:'changed'});return {safeThrough:input.text.length}}]){
    const f=fixture(assess)
    try{await assert.rejects(f.writer.push('private'));assert.equal(published(f),'');await new Promise<void>(resolve=>setImmediate(resolve))}finally{f.writer.dispose()}
  }
})
it('public input budget suspension does not add a final-answer length limit',async()=>{
  const f=fixture(({text})=>({safeThrough:text.length})),text='x'.repeat(200_001)
  try{await f.writer.push(text);await f.writer.finish(text);await f.writer.end('completed');assert.equal(published(f),'')}finally{f.writer.dispose()}
})
it('one-character input runs the cumulative policy at bounded coalescing boundaries',async t=>{
  let calls=0;const f=fixture(({text})=>{calls++;return {safeThrough:text.length}}),start=performance.now()
  try{for(const point of 'x'.repeat(16_000))await f.writer.push(point);await f.writer.finish();await f.writer.end('completed')
    assert.equal(published(f).length,16_000);assert.ok(calls<=6,`policy was scanned ${calls} times`)
    t.diagnostic(`16000 one-character deltas: ${calls} policy calls, ${(performance.now()-start).toFixed(2)}ms`)
  }finally{f.writer.dispose()}
})
it('EOF validates the complete result without inventing public chunks absent from provider deltas',async()=>{
  for(const prefix of ['', 'observed prefix']){
    let complete='';const f=fixture(input=>{if(input.isFinal)complete=input.text;return {safeThrough:input.text.length}})
    try{
      if(prefix)await f.writer.push(prefix)
      await f.writer.finish(prefix+' unseen final suffix');await f.writer.end('completed')
      assert.equal(complete,prefix+' unseen final suffix')
      assert.equal(published(f),prefix)
      if(!prefix)assert.equal(f.events.length,0)
    }finally{f.writer.dispose()}
  }
})
