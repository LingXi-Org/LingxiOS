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
