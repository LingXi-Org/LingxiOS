import assert from 'node:assert/strict'
import { it } from 'node:test'
import { consumeRunEvent, consumeRunState, consumeRunStreamEvent, consumePublicTextAttempts, createRunView } from '../src/ui/index.js'
import { OpenAIChatDriver } from '../src/model/openai.js'
import type { RunEvent } from '../src/protocol/types.js'
import type { RunState } from '../src/app/jobs.js'

const identity = { version: 1, requestVersion: 1, fence: 1, attemptId: 'call-1', partId: 'part-1', partIndex: 0 }
const event = (seq: number, data: Record<string, unknown>, ended = false): RunEvent => ({ runId: 'run', seq,
  kind: ended ? 'public.text.ended' : 'public.text.delta', stage: ended ? 'completed' : 'delta', visibility: 'user', data: { ...identity,...data } })
const parts = (view: ReturnType<typeof createRunView>) => (Reflect.get(view,'publicTextParts') ?? []) as unknown as Array<Record<string, unknown>>
const state = (fence = 1, requestVersion = 1, status: RunState['run']['status'] = 'failed'): RunState => ({
  run: { id: 'run', fence,requestVersion,status,kind: 'turn',attempts: fence,resultId: null,resultFence: null,createdAt: '',availableAt: '',
    heartbeatAt: null,lastProgressAt: null,goalOutcome: null,error: null }, message: null,delivery: null })

it('archives durable public text across reset, tools and terminal state without making it an answer', () => {
  let view = consumeRunEvent(createRunView('run'),event(1,{chunkIndex:0,text:'公开说明'}))
  view = consumeRunEvent(view,event(2,{chunkCount:1,reason:'tool'},true))
  view = consumeRunStreamEvent(view,{ type:'reset',runId:'run',reason:'unavailable' })
  view = consumeRunState(view,state())
  assert.equal(parts(view)[0]?.['text'],'公开说明')
  assert.equal(parts(view)[0]?.['reason'],'tool')
  assert.equal(view.message,null)
  assert.equal(view.draft,'')
})
it('replays old fences after a newer terminal state and keeps same-fence provider attempts separate', () => {
  const events = [event(1,{chunkIndex:0,text:'第一尝试'}),event(2,{chunkCount:1,reason:'superseded'},true),
    event(3,{attemptId:'call-2',partId:'part-2',chunkIndex:0,text:'第二尝试'}),
    event(4,{attemptId:'call-2',partId:'part-2',chunkCount:1,reason:'failed'},true)]
  let live=createRunView('run'), replay=consumeRunState(createRunView('run'),state(2,2))
  for(const item of events){ live=consumeRunEvent(live,item); replay=consumeRunEvent(replay,item) }
  live=consumeRunState(live,state(2,2))
  assert.deepEqual(parts(replay),parts(live))
  assert.equal(parts(replay).length,2)
  assert.deepEqual(parts(replay).map(part=>part['text']),['第一尝试','第二尝试'])
  assert.deepEqual(parts(consumeRunEvent(replay,events[0]!)),parts(replay))
})
it('retains more than eighty independently identified public parts across event pages', () => {
  let view=createRunView('run')
  for(let i=0;i<81;i++){
    const id={partId:`part-${i}`,attemptId:`call-${i}`}
    view=consumeRunEvent(view,event(i*2+1,{...id,chunkIndex:0,text:`说明${i}`}))
    view=consumeRunEvent(view,event(i*2+2,{...id,chunkCount:1,reason:'completed'},true))
  }
  assert.equal(parts(view).length,81)
  assert.equal(parts(view).at(-1)?.['text'],'说明80')
})
it('the official model driver awaits async delta acknowledgement before completing', async () => {
  let release!:()=>void
  const gate=new Promise<void>(resolve=>{ release=resolve })
  let seen!:()=>void
  const received=new Promise<void>(resolve=>{seen=resolve})
  const driver=new OpenAIChatDriver('public-text-ack',{apiKey:'fixture',maxAttempts:1,fetchImpl:async()=>new Response(
    'data: {"choices":[{"delta":{"content":"public"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')})
  let finished=false
  const task=driver.run({instructions:'fixture',items:[],onTextDelta:async()=>{seen();await gate}}).then(()=>{finished=true})
  try { await received; await new Promise<void>(resolve=>setImmediate(resolve)); assert.equal(finished,false) }
  finally { release(); await task }
})

it('late durable attempt metadata corrects inferred state but never overrides an explicit part end', () => {
  let replay=consumeRunState(createRunView('run'),state(2,2))
  replay=consumeRunEvent(replay,event(1,{chunkIndex:0,text:'crashed prefix'}))
  assert.equal(parts(replay)[0]?.['reason'],'superseded')
  replay=consumePublicTextAttempts(replay,[{fence:1,reason:'failed'}])
  assert.equal(parts(replay)[0]?.['reason'],'failed')
  assert.equal(parts(replay)[0]?.['endedSeq'],null)
  replay=consumeRunEvent(replay,event(2,{chunkCount:1,reason:'tool'},true))
  replay=consumePublicTextAttempts(replay,[{fence:1,reason:'cancelled'}])
  assert.equal(parts(replay)[0]?.['reason'],'tool')
  assert.equal(parts(replay)[0]?.['endedSeq'],2)
})
it('a revised request in the same fence marks its unfinished prior version superseded',()=>{
  let view=consumeRunEvent(createRunView('run'),event(1,{chunkIndex:0,text:'prior version'}))
  view=consumeRunState(view,{...state(1,2),publicTextAttempts:[{fence:1,reason:'failed'}]})
  assert.equal(view.publicTextParts?.[0]?.reason,'superseded')
})

it('only committed result identity associates an accepted public part, including state-first and old-fence replay',()=>{
  const message={version:2 as const,runId:'run',agentId:'agent',sessionId:'room',body:'final',publicTextPartId:'part-2',
    envelope:{version:1 as const,evidenceSnapshotId:'evidence',body:'final',requestVersion:1,goalOutcome:{status:'satisfied' as const,verification:'inconclusive' as const,requestVersion:1},citations:[],artifacts:[]}}
  const committedState:RunState={...state(1,1,'succeeded'),message,run:{...state().run,status:'succeeded',resultId:'result-1',resultFence:1}}
  const items=[event(1,{chunkIndex:0,text:'final'}),event(2,{chunkCount:1,reason:'tool'},true),
    event(3,{partId:'part-2',attemptId:'call-2',chunkIndex:0,text:'final'}),
    event(4,{partId:'part-2',attemptId:'call-2',chunkCount:1,reason:'completed'},true)]
  let live=createRunView('run'),replay=consumeRunState(createRunView('run'),committedState)
  for(const item of items){live=consumeRunEvent(live,item);replay=consumeRunEvent(replay,item)}
  assert.deepEqual(parts(live).map(part=>part['acceptedResultId']),[null,null],'completed alone is not committed acceptance')
  assert.deepEqual(parts(replay).map(part=>part['acceptedResultId']),[null,'result-1'])
  const commit:RunEvent={runId:'run',seq:5,kind:'response.committed',stage:'completed',visibility:'user',data:{resultId:'result-1',requestVersion:1,publicTextPartId:'part-2'}}
  live=consumeRunState(consumeRunEvent(live,commit),committedState)
  replay=consumeRunEvent(replay,commit)
  assert.deepEqual(parts(live),parts(replay))
  let old=consumeRunState(createRunView('run'),state(2,2))
  for(const item of [...items,commit])old=consumeRunEvent(old,item)
  assert.deepEqual(parts(old).map(part=>part['acceptedResultId']),[null,'result-1'])
  assert.equal(old.message,null,'old accepted history must not replace the current answer')
  assert.equal(old.fence,2)
})

it('a retained older-fence source associates only within the exact request version',()=>{
  let view=consumeRunState(createRunView('run'),state(3,2))
  view=consumeRunEvent(view,event(1,{chunkIndex:0,text:'older candidate'}))
  view=consumeRunEvent(view,{runId:'run',seq:100001,kind:'response.committed',stage:'completed',visibility:'user',data:{resultId:'accepted-old',publicTextPartId:'part-1',requestVersion:1}})
  assert.equal(view.publicTextParts?.[0]?.acceptedResultId,'accepted-old')
  assert.equal(view.publicTextParts?.[0]?.reason,'superseded','acceptance does not rewrite attempt termination')
  view=consumeRunEvent(view,{runId:'run',seq:200001,kind:'response.committed',stage:'completed',visibility:'user',data:{resultId:'wrong-version',publicTextPartId:'part-1',requestVersion:2}})
  assert.equal(view.publicTextParts?.[0]?.acceptedResultId,'accepted-old')
})
