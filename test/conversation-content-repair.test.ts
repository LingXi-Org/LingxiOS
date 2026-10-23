import assert from 'node:assert/strict'
import { it } from 'node:test'
import { AgentRuntime, type AgentRuntimeOptions, type RootModelBudgetOptions } from '../src/runtime/runtime.js'
import { ModelDriverError } from '../src/errors.js'
import { assembleHarness } from '../src/harness/profile.js'
import { DefaultRuntimePolicy } from '../src/runtime/policy.js'
import type { HostPort } from '../src/host/port.js'
import type { ModelDriver } from '../src/model/driver.js'
import type { AssistantMessage, SessionRecord, TurnContext, WorkCompletion } from '../src/protocol/types.js'
import type { ExecutionStep } from '../src/control-plane/steps.js'
import { durableProtocol } from './protocol-fixture.js'
import { candidateHash } from '../src/outcome/verification.js'
import { OpenAIChatDriver } from '../src/model/openai.js'

// Failure model: docs/evidence/conversation-delivery-repair/FAILURE-MODEL.md.
const original = 'Create a complete interactive comparison.'
const usage = { available: true,inputTokens: 100,outputTokens: 20 }
function fixture(request = original) {
  const work: TurnContext['work'] = { id: 'conversation-repair',tenantId: 'tenant',agentId: 'agent',sessionId: 'room',principalId: 'human',
    kind: 'turn',lane: 'interactive',triggerRef: 'request',fence: 1,homeEpoch: 1,leaseToken: 'token',
    meta: { conversationTurn: true,mode: 'execute',deliveryMode: 'auto',codeExecution: 'disabled' },
    conversation: { conversationId: 'room',policyVersion: 1,source: { messageId: 'request',version: 1 },internal: false,
      audience: { visibility: 'conversation',participantIds: ['human','agent','peer'] } } }
  let committed: AssistantMessage | undefined, completion: WorkCompletion | undefined, session: SessionRecord | null = null
  const steps: ExecutionStep[] = [], protocol = durableProtocol()
  const harness = assembleHarness({ id: 'conversation-repair',version: '1',mode: 'execute',capabilities: [] }).context
  const host: HostPort = { ...protocol,claimWork: async () => null,heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ work,persona: { name: 'Agent',role: '',instructions: '' },capabilities: [],
      harness,executionSteps: structuredClone(steps),
      ...(steps.findLast(step => step.kind === 'runtime.checkpoint') ? { executionCheckpoint: steps.findLast(step => step.kind === 'runtime.checkpoint')!.input as unknown as NonNullable<TurnContext['executionCheckpoint']> } : {}),
      messages: [{ ref: 'request',authorId: 'human',authorName: 'Human',authorKind: 'human',body: request,createdAt: 'now' }] }),
    executeAction: async () => ({ ok: true,value: { requestVersion: 1,pending: [],truncated: false } }),
    saveStep: async (owner,step) => { await protocol.saveStep(owner,step); steps.push(structuredClone(step)) },
    loadSession: async () => structuredClone(session),saveSession: async (_work,value) => { session = structuredClone(value) },emitEvent: async () => {},
    commitResult: async (_work,message) => { committed = message },completeWork: async (_work,value) => { completion = value },yieldWork: async () => {} }
  return { work,host,steps,result: () => ({ committed,completion }) }
}
const kernel = { execute: async (): Promise<never> => { throw new Error('no kernel for this conversation') } }

for (const assessment of [false,true]) it(`repairs an ordinary conversation omission (${assessment ? 'self-assessment' : 'content review'})`,async () => {
  const f = fixture(); let turns = 0,reviews = 0
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async request => {
      reviews++
      return { model: 'reviewer',usage,value: Array.isArray((request.input as { findings?: unknown }).findings) ? { deferred: [] }
        : turns === 1 ? { missing: [{ quote: original,reason: 'The interactive comparison is missing.' }] } : { missing: [] } }
    },
    run: async request => {
      turns++
      if (turns === 2) assert.match(JSON.stringify(request.items),/fix the omissions/)
      const body = turns === 1 ? 'The comparison below explains each layer.' : 'The complete comparison is supplied.'
      return assessment ? { text: '',output: [],usage,finalCandidate: JSON.stringify({ body,status: turns === 1 ? 'partial' : 'satisfied',
        gaps: turns === 1 ? ['Comparison not yet created'] : [],checks: [{ requirement: original,status: turns === 1 ? 'unknown' : 'met',basis: 'Fixture' }] }) }
        : { text: body,output: [{ role: 'assistant',content: body }],usage }
    } }
  await new AgentRuntime(f.host,model,kernel,{ semanticReview: 'required' }).runWork(f.work)
  assert.equal(turns,2)
  assert.equal(reviews,2, 'one joint review per candidate, without a serial scope call')
  assert.equal(f.result().committed?.body,'The complete comparison is supplied.')
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'satisfied')
})

it('bounds repeated omissions and retains truthful partial content',async () => {
  const f = fixture(); let turns = 0
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async request => ({ model: 'reviewer',usage,value: Array.isArray((request.input as { findings?: unknown }).findings)
      ? { deferred: [] } : { missing: [{ quote: original,reason: 'Still missing the requested comparison.' }] } }),
    run: async () => { turns++; return { text: 'A useful partial explanation.',output: [{ role: 'assistant',content: 'A useful partial explanation.' }],usage } } }
  await new AgentRuntime(f.host,model,kernel,{ semanticReview: 'required' }).runWork(f.work)
  assert.equal(turns,3)
  assert.equal(f.result().committed?.body,'A useful partial explanation.')
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'partial')
  assert.match(JSON.stringify(f.result().committed?.envelope.goalOutcome.gaps),/correction budget exhausted/i)
})

it('does not retry a finding grounded in an explicit human blocker',async () => {
  const f = fixture(); let turns = 0
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async () => ({ model: 'reviewer',usage,value: { missing: [{ quote: original,blockedBy: original,reason: 'Human boundary fixture.' }] } }),
    run: async () => { turns++; return { text: 'The requested comparison remains unavailable.',output: [],usage } } }
  await new AgentRuntime(f.host,model,kernel,{ semanticReview: 'required' }).runWork(f.work)
  assert.equal(turns,1)
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'partial')
})

it('only a trusted product hook defers repair and cannot skip resource checks',async () => {
  const f = fixture(); let turns = 0,checks = 0
  const policy = new class extends DefaultRuntimePolicy {
    deferConversationRepair(text: string,context: TurnContext) {
      assert.equal(text,'@peer Please check this contribution.')
      assert.equal(context.work.id,f.work.id)
      return true
    }
  }()
  f.host.verifyCandidate = async (_work,candidate) => { checks++; return { candidateHash: candidateHash(candidate),requestVersion: candidate.requestVersion,
    records: checks === 1 ? [{ checker: 'resource',status: 'failed',evidence: { reason: 'resource not ready' } }] : [] } }
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async request => ({ model: 'reviewer',usage,value: Array.isArray((request.input as { findings?: unknown }).findings)
      ? { deferred: [] } : { missing: [{ quote: original,reason: 'Peer contribution pending.' }] } }),
    run: async () => { turns++; return { text: '@peer Please check this contribution.',output: [],usage } } }
  await new AgentRuntime(f.host,model,kernel,{ policy,semanticReview: 'required' }).runWork(f.work)
  assert.equal(turns,2,'resource failure still repairs before peer handoff can commit')
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'partial')
})

// Failure inventory: docs/evidence/content-correction-allowance/FAILURE-MODEL.md.
const recoveryRequest = 'Explain how a circle\'s area changes when its radius doubles, with concrete examples.'
const recoveryAnswer = 'A circle has area πr². A radius of 1 gives area π, and a radius of 2 gives area 4π. Doubling the radius quadruples the area because both dimensions scale by two.'
const promise = 'I will prepare the explanation and examples.'
it('combines real public protocol recovery, joint review and bounded content completion',async () => {
  const f = fixture(recoveryRequest); let turns = 0,reviews = 0,settled = 0
  const record = f.host.recordModelUsage
  f.host.recordModelUsage = async (...args) => { await record(...args); settled++ }
  const model = new OpenAIChatDriver('synthetic-combined', { apiKey: 'synthetic',publicTextProtocol: 'purpose-json-v1',
    maxAttempts: 1,recovery: { maxAttempts: 1,totalTimeoutMs: 10_000 },fetchImpl: async (_url,init) => {
      const request = JSON.parse(String(init?.body))
      if (!request.stream) {
        reviews++
        assert.match(JSON.stringify(request.messages),/SAME response/,'content and scope use the joint review contract')
        const value = { missing: turns === 3 ? [{ quote: recoveryRequest,reason: 'Explanation and examples are missing.' }] : [],limitations: [],deferred: [] }
        return Response.json({ choices: [{ finish_reason: 'stop',message: { content: JSON.stringify(value) } }],usage: { prompt_tokens: 100,completion_tokens: 20 } })
      }
      turns++
      if (turns === 2 || turns === 3) assert.match(JSON.stringify(request.messages),/purpose-json-v1/)
      if (turns === 4) assert.match(JSON.stringify(request.messages),/fix the omissions/)
      const content = JSON.stringify({ commentary: '',answer: turns <= 2 ? '' : turns === 3 ? promise : recoveryAnswer })
      return new Response('data: '+JSON.stringify({ choices: [{ delta: { content },finish_reason: 'stop' }],usage: { prompt_tokens: 100,completion_tokens: 20 } })+'\n\ndata: [DONE]\n\n')
    } })
  await recoveryRuntime(f,model,3,{ maxModelCalls: 8,maxTokens: 200_000,wallClockMs: 30_000 }).runWork(f.work)
  assert.deepEqual({ turns,reviews,settled },{ turns: 4,reviews: 2,settled: 6 })
  assert.equal(f.result().committed?.body,recoveryAnswer)
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'satisfied')
  // Successful work uses commitResult's atomic completion path; this fixture's
  // completeWork callback only records non-result terminal paths.
  assert.equal(f.result().completion,undefined)
  assert.equal(f.steps.find(step => step.kind === 'runtime.binding')?.input['additionalContentCorrections'],3)
})
function recoveryRuntime(f: ReturnType<typeof fixture>,model: ModelDriver,extra?: number,rootModelBudget: RootModelBudgetOptions = {}) {
  const options: AgentRuntimeOptions = { semanticReview: 'required',rootModelBudget,...(extra === undefined ? {} : { additionalContentCorrections: extra }) }
  return new AgentRuntime(f.host,model,kernel,options)
}
function protocolThenOmission(alwaysMissing = false) {
  let turns = 0,reviews = 0
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async request => {
      reviews++
      const input = request.input as { findings?: unknown; body: string }
      return { model: 'synthetic',usage,value: Array.isArray(input.findings) ? { deferred: [] }
        : input.body === recoveryAnswer ? { missing: [] }
          : { missing: [{ quote: recoveryRequest,reason: 'The explanation and numeric examples are missing.' }] } }
    },
    run: async request => {
      turns++
      if (turns <= 2) throw new ModelDriverError('Synthetic malformed response',{ kind: 'protocol',finishReasons: ['stop'],usage })
      if (turns === 4) assert.match(JSON.stringify(request.items),/fix the omissions/)
      const text = alwaysMissing || turns === 3 ? promise : recoveryAnswer
      return { text,output: [{ role: 'assistant',content: text }],usage }
    } }
  return { model,counts: () => ({ turns,reviews }) }
}

for (const extra of [0,3]) for (const alwaysMissing of [false,true]) it(`bounds content repair after two protocol failures (extra=${extra}, persistent=${alwaysMissing})`,async () => {
  const f = fixture(recoveryRequest), synthetic = protocolThenOmission(alwaysMissing)
  // Metadata is untrusted and cannot override the host's default allowance.
  f.work.meta = { ...f.work.meta,additionalContentCorrections: 3 }
  await recoveryRuntime(f,synthetic.model,extra,{ maxModelCalls: 16,maxTokens: 1_000_000,wallClockMs: 30_000 }).runWork(f.work)
  const repaired = extra > 0 && !alwaysMissing
  assert.equal(synthetic.counts().turns,extra === 0 ? 3 : alwaysMissing ? 6 : 4)
  assert.equal(synthetic.counts().reviews,extra === 0 ? 1 : alwaysMissing ? 4 : 2)
  assert.equal(f.result().committed?.envelope.goalOutcome.status,repaired ? 'satisfied' : 'partial')
  assert.equal(f.result().committed?.body,repaired ? recoveryAnswer : promise)
  if (!repaired) assert.match(JSON.stringify(f.result().committed?.envelope.goalOutcome.gaps),/correction budget exhausted/i)
})

for (const limit of ['calls','tokens','cost','deadline'] as const) it(`does not let extra content corrections spend beyond the root ${limit} budget`,async t => {
  const f = fixture(recoveryRequest), synthetic = protocolThenOmission()
  // Each issued attempt uses exactly 100 input + 20 output tokens. The fourth
  // call finishes the joint content/scope check, before extra repair could start.
  const model: ModelDriver = { ...synthetic.model,countTokens: () => 100,maxOutputTokens: 20 }
  let settled = 0, now = Date.now()
  if (limit === 'deadline') t.mock.method(Date,'now',() => now)
  const record = f.host.recordModelUsage
  f.host.recordModelUsage = async (...args) => { await record(...args); if (++settled === 4 && limit === 'deadline') now += 1000 }
  await recoveryRuntime(f,model,3,{ maxModelCalls: limit === 'calls' ? 4 : 16,
    maxTokens: limit === 'tokens' ? 480 : 1_000_000,maxCostMicros: limit === 'cost' ? 480 : 1_000_000,
    inputCostMicrosPerMillion: 1_000_000,outputCostMicrosPerMillion: 1_000_000,wallClockMs: limit === 'deadline' ? 1000 : 30_000 }).runWork(f.work)
  assert.deepEqual(synthetic.counts(),{ turns: 3,reviews: 1 })
  assert.equal(settled,4)
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'partial')
  assert.match(JSON.stringify(f.result().committed?.envelope.goalOutcome.gaps),/Model call, token, cost or execution-time budget exhausted/)
})

it('stops on cancellation before issuing the additional content correction',async () => {
  const f = fixture(recoveryRequest), synthetic = protocolThenOmission(); let cancelled = false
  f.host.emitEvent = async (_work,event) => { if (event.kind === 'response.content_checked') cancelled = true }
  f.host.heartbeat = async () => ({ ok: true,cancelRequested: cancelled })
  await recoveryRuntime(f,synthetic.model,3).runWork(f.work)
  assert.deepEqual(synthetic.counts(),{ turns: 3,reviews: 1 })
  assert.equal(f.result().committed,undefined)
  assert.equal(f.result().completion?.status,'cancelled')
})

it('restores spent content corrections after yielding the same work to a new owner',async () => {
  const f = fixture(recoveryRequest), synthetic = protocolThenOmission(true), pause = new AbortController()
  const save = f.host.saveStep
  f.host.saveStep = async (work,step) => {
    await save(work,step)
    if (step.kind === 'runtime.checkpoint' && step.input['count'] === 4) pause.abort()
  }
  await recoveryRuntime(f,synthetic.model,3).runWork(f.work,pause.signal)
  assert.equal(pause.signal.aborted,true)
  assert.equal(synthetic.counts().turns,4)
  assert.equal(f.result().committed,undefined)
  f.host.saveStep = save; f.work.fence++
  await recoveryRuntime(f,synthetic.model,3).runWork(f.work)
  assert.deepEqual(synthetic.counts(),{ turns: 6,reviews: 4 })
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'partial')
})

it('binds nondefault correction configuration and preserves zero/default compatibility',async () => {
  for (const [first,next] of [[undefined,0],[0,undefined],[0,3],[3,0],[3,2],[3,3]] as const) {
    const f = fixture(); let turns = 0
    const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
      structured: async () => ({ model: 'synthetic',usage,value: { missing: [] } }),
      run: async () => { turns++; return { text: 'The complete comparison.',output: [],usage } } }
    await recoveryRuntime(f,model,first).runWork(f.work)
    const binding = f.steps.find(step => step.kind === 'runtime.binding')!
    assert.equal(binding.input['additionalContentCorrections'],first ? first : undefined)
    f.work.fence++
    await recoveryRuntime(f,model,next).runWork(f.work)
    const compatible = (first ?? 0) === (next ?? 0)
    assert.equal(turns,compatible ? 2 : 1,'a changed configuration must fail before calling the model')
    if (!compatible) assert.equal(f.result().completion?.status,'failed')
  }
})

function withoutHarness(f: ReturnType<typeof fixture>) {
  const load = f.host.loadContext
  f.host.loadContext = async work => { const { harness: _harness,...context } = await load(work); return context }
}

it('binds nonzero configuration without a harness and rejects changes before another model call',async () => {
  for (const next of [0,2,3]) {
    const f = fixture(); withoutHarness(f)
    let turns = 0
    const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
      structured: async () => ({ model: 'synthetic',usage,value: { missing: [] } }),
      run: async () => { turns++; return { text: 'The complete comparison.',output: [],usage } } }
    await recoveryRuntime(f,model,3).runWork(f.work)
    assert.equal(f.steps.find(step => step.kind === 'runtime.binding')?.input['additionalContentCorrections'],3)
    f.work.fence++
    await recoveryRuntime(f,model,next).runWork(f.work)
    assert.equal(turns,next === 3 ? 2 : 1)
    if (next !== 3) assert.equal(f.result().completion?.status,'failed')
  }
})

it('cannot change the bound default allowance after yielding',async () => {
  for (const extra of [0,3]) {
    const f = fixture(recoveryRequest), synthetic = protocolThenOmission(true), pause = new AbortController()
    withoutHarness(f)
    const save = f.host.saveStep
    f.host.saveStep = async (work,step) => {
      await save(work,step)
      if (step.kind === 'runtime.checkpoint' && step.input['count'] === 1) pause.abort()
    }
    await recoveryRuntime(f,synthetic.model).runWork(f.work,pause.signal)
    assert.equal(pause.signal.aborted,true)
    assert.equal(synthetic.counts().turns,1)
    assert.equal(f.steps.some(step => step.kind === 'runtime.binding'),true)
    f.host.saveStep = save; f.work.fence++
    await recoveryRuntime(f,synthetic.model,extra).runWork(f.work)
    assert.equal(synthetic.counts().turns,extra ? 1 : 3,'an unbound historical run cannot acquire extra corrections')
    if (extra) assert.equal(f.result().completion?.status,'failed')
    else assert.equal(f.result().committed?.envelope.goalOutcome.status,'partial')
  }
})

it('rejects additional content allowances outside trusted bounded integer configuration',() => {
  const f = fixture(), synthetic = protocolThenOmission()
  for (const extra of [-1,4,0.5,Number.NaN,Number.POSITIVE_INFINITY,Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => recoveryRuntime(f,synthetic.model,extra),/additionalContentCorrections/)
  }
})

// Failure inventory: docs/evidence/grounded-content-repair/FAILURE-MODEL.md.
for (const source of ['content','resource','self-assessment'] as const) it(`repairs the exact reviewed candidate for ${source}`,async () => {
  const f = fixture(); let turns = 0
  const draft = 'Preserve this useful comparison; the interactive control is still missing.'
  if (source === 'resource') f.host.verifyCandidate = async (_work,candidate) => ({ candidateHash: candidateHash(candidate),requestVersion: candidate.requestVersion,
    records: turns === 1 ? [{ checker: 'resource',status: 'failed',evidence: { reason: 'Control missing' } }] : [] })
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async () => ({ model: 'synthetic',usage,value: { missing: source !== 'resource' && turns === 1
      ? [{ quote: original,reason: 'The interactive control is missing.' }] : [] } }),
    run: async request => {
      if (++turns === 2) {
        const text = JSON.stringify(request.items)
        assert.match(text,/Repair candidate context/)
        assert.ok(text.includes(draft),'the exact candidate must survive even when output history is empty')
        assert.ok(text.includes(candidateHash({ body: draft,requestVersion: 1,artifacts: [] })))
        assert.match(text,/requestVersion/)
      }
      const body = turns === 1 ? draft : 'The complete interactive comparison.'
      return source === 'self-assessment' ? { text: '',output: [],usage,finalCandidate: JSON.stringify({ body,status: turns === 1 ? 'partial' : 'satisfied',
        gaps: turns === 1 ? ['Interactive control missing'] : [],checks: [{ requirement: original,status: turns === 1 ? 'unknown' : 'met',basis: body }] }) }
        : { text: body,output: [],usage }
    } }
  await new AgentRuntime(f.host,model,kernel,{ semanticReview: 'required' }).runWork(f.work)
  assert.equal(turns,2)
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'satisfied')
})

it('does not generate again for optional polish while retaining real missing work',async () => {
  for (const required of [false,true]) {
    const f = fixture(); let turns = 0
    const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
      structured: async () => ({ model: 'synthetic',usage,value: { missing: turns === 1 ? [
        { quote: original,reason: 'An optional color theme could improve appearance.',priority: 'optional' },
        ...(required ? [{ quote: original,reason: 'Interactive controls are missing.' }] : [])] : [] } }),
      run: async () => ({ text: ++turns === 1 ? 'The comparison.' : 'The complete comparison with controls.',output: [],usage }) }
    await new AgentRuntime(f.host,model,kernel,{ semanticReview: 'required' }).runWork(f.work)
    assert.equal(turns,required ? 2 : 1)
    assert.equal(f.result().committed?.envelope.goalOutcome.status,'satisfied')
  }
})

for (const blocked of [false,true]) it(`handles a limitations-only candidate with a ${blocked ? 'human blocker' : 'repairable omission'}`,async () => {
  const constraint = 'I have not supplied the input data; do not retrieve it elsewhere.'
  const request = blocked ? original+' '+constraint : original
  const f = fixture(request); let turns = 0
  const draft = blocked ? 'The comparison needs the input data. Please supply it.' : 'The interactive comparison has not been created yet.'
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async () => ({ model: 'synthetic',usage,value: { missing: [],limitations: turns === 1
      ? [{ quote: draft,requestQuote: original,reason: 'The requested comparison is unavailable.',...(blocked ? { blockedBy: constraint } : {}) }] : [] } }),
    run: async request => {
      if (++turns === 2) { assert.ok(JSON.stringify(request.items).includes(draft)); assert.match(JSON.stringify(request.items),/requestQuote/) }
      return { text: turns === 1 ? draft : 'The complete interactive comparison.',output: [],usage }
    } }
  await new AgentRuntime(f.host,model,kernel,{ semanticReview: 'required' }).runWork(f.work)
  assert.equal(turns,blocked ? 1 : 2)
  assert.equal(f.result().committed?.envelope.goalOutcome.status,blocked ? 'partial' : 'satisfied')
  if (blocked) assert.match(JSON.stringify(f.result().committed?.envelope.goalOutcome.gaps),/input data/)
})

it('drops repair context invalidated by a new human request version',async () => {
  const f = fixture(); let turns = 0,steer = false
  f.host.emitEvent = async (_work,event) => { if (event.kind === 'response.content_checked' && turns === 1) steer = true }
  f.host.heartbeat = async () => ({ ok: true,...(steer ? { steer: [{ id: 'new-request',text: 'Just say hello.',createdAt: 'now' }] } : {}) })
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async () => ({ model: 'synthetic',usage,value: { missing: turns === 1 ? [{ quote: original,reason: 'Missing comparison.' }] : [] } }),
    run: async request => {
      if (++turns === 2) {
        assert.match(JSON.stringify(request.items),/Just say hello/)
        assert.doesNotMatch(JSON.stringify(request.items),/Repair candidate context|fix the omissions/)
      }
      return { text: turns === 1 ? 'Stale comparison draft.' : 'Hello.',output: [],usage }
    } }
  await new AgentRuntime(f.host,model,kernel,{ semanticReview: 'required' }).runWork(f.work)
  assert.equal(turns,2)
  assert.equal(f.result().committed?.envelope.goalOutcome.requestVersion,2)
  assert.equal(f.result().committed?.body,'Hello.')
})


it('reviews a partial self-assessment before repeating a human-blocked draft',async () => {
  const constraint = 'The input data is not supplied; do not retrieve it elsewhere.'
  const f = fixture(original+' '+constraint); let turns = 0,reviews = 0
  const body = 'The comparison needs your input data. Please supply it.'
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async () => { reviews++; return { model: 'synthetic',usage,value: {
      missing: [{ quote: original,reason: 'The required input is unavailable.',blockedBy: constraint }],limitations: [] } } },
    run: async () => { turns++; return { text: '',output: [],usage,finalCandidate: JSON.stringify({ body,status: 'partial',
      gaps: ['The input data is unavailable.'],checks: [{ requirement: original,status: 'unknown',basis: body }] }) } } }
  await new AgentRuntime(f.host,model,kernel,{ semanticReview: 'required' }).runWork(f.work)
  assert.deepEqual({ turns,reviews },{ turns: 1,reviews: 1 })
  assert.equal(f.result().committed?.body,body)
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'partial')
})


it('cannot downgrade a currently due declared limitation to optional polish',async () => {
  const f = fixture(); let turns = 0
  const body = 'The requested interactive comparison has not been created.'
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async () => ({ model: 'synthetic',usage,value: { missing: [],limitations: turns === 1
      ? [{ quote: body,requestQuote: original,reason: 'The currently due deliverable is missing.',priority: 'optional' }] : [] } }),
    run: async () => ({ text: ++turns === 1 ? body : 'The complete interactive comparison.',output: [],usage }) }
  await new AgentRuntime(f.host,model,kernel,{ semanticReview: 'required' }).runWork(f.work)
  assert.equal(turns,2)
  assert.equal(f.result().committed?.body,'The complete interactive comparison.')
})

for (const mismatch of ['hash','version'] as const) it(`rejects stale verification ${mismatch} without repairing a different candidate`,async () => {
  const f = fixture(); let turns = 0
  f.host.verifyCandidate = async (_work,candidate) => ({ candidateHash: mismatch === 'hash' ? 'stale-hash' : candidateHash(candidate),
    requestVersion: mismatch === 'version' ? 0 : candidate.requestVersion,
    records: [{ checker: 'stale-record',status: 'failed',evidence: { reason: 'Not this candidate' } }] })
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async request => { assert.doesNotMatch(JSON.stringify(request.input),/stale-record/); return { model: 'synthetic',usage,value: { missing: [] } } },
    run: async () => { turns++; return { text: 'The complete comparison.',output: [],usage } } }
  await new AgentRuntime(f.host,model,kernel,{ semanticReview: 'required' }).runWork(f.work)
  assert.equal(turns,1)
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'partial')
  assert.match(JSON.stringify(f.result().committed?.envelope.goalOutcome.gaps),/verification identity/)
})


// Direct-loop default: no semantic review inference from grammar, execution mode,
// revisions, artifacts or ordinary tool work. Deterministic checks still run.
for (const text of ['What is 2 + 2?','Explain gravity and give an example.','Create a complete interactive comparison.']) it(`answers directly by default: ${text}`,async () => {
  const f = fixture(text); let turns = 0,reviews = 0
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async () => { reviews++; throw new Error('default execution must not invoke a semantic reviewer') },
    run: async request => { turns++; assert.match(request.instructions,/in the same generation/); assert.doesNotMatch(request.instructions,/runtime independently reviews complex candidates/); return { text: 'A complete answer.',output: [],usage } } }
  await new AgentRuntime(f.host,model,kernel).runWork(f.work)
  assert.deepEqual({ turns,reviews },{ turns: 1,reviews: 0 })
  assert.equal(f.result().committed?.body,'A complete answer.')
})

it('keeps a directly returned partial self-assessment truthful without review or rewriting',async () => {
  const f = fixture(); let turns = 0,reviews = 0
  const body = 'The comparison needs data that is not available.'
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async () => { reviews++; throw new Error('unexpected review') },
    run: async () => { turns++; return { text: '',output: [],usage,finalCandidate: JSON.stringify({ body,status: 'partial',
      gaps: ['The requested input is unavailable.'],checks: [{ requirement: original,status: 'unknown',basis: body }] }) } } }
  await new AgentRuntime(f.host,model,kernel).runWork(f.work)
  assert.deepEqual({ turns,reviews },{ turns: 1,reviews: 0 })
  assert.equal(f.result().committed?.body,body)
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'partial')
})


it('repairs native verification failures without semantic review',async () => {
  const f = fixture(); let turns = 0,reviews = 0
  f.host.verifyCandidate = async (_work,candidate) => ({ candidateHash: candidateHash(candidate),requestVersion: candidate.requestVersion,
    records: turns === 1 ? [{ checker: 'file',status: 'failed',evidence: { reason: 'Referenced artifact is missing' } }] : [] })
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async () => { reviews++; throw new Error('unexpected semantic review') },
    run: async request => { if (++turns === 2) assert.match(JSON.stringify(request.items),/Referenced artifact is missing/)
      return { text: turns === 1 ? 'Initial candidate.' : 'Corrected candidate.',output: [],usage } } }
  await new AgentRuntime(f.host,model,kernel).runWork(f.work)
  assert.deepEqual({ turns,reviews },{ turns: 2,reviews: 0 })
  assert.equal(f.result().committed?.body,'Corrected candidate.')
})

it('keeps unresolved durable action receipts partial without semantic review',async () => {
  const f = fixture(); let turns = 0,reviews = 0
  f.host.executeAction = async () => ({ ok: true,value: { requestVersion: 1,pending: [{ action: 'record.update',state: 'unknown' }],truncated: false } })
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async () => { reviews++; throw new Error('unexpected semantic review') },
    run: async () => { turns++; return { text: 'The update could not be confirmed.',output: [],usage } } }
  await new AgentRuntime(f.host,model,kernel).runWork(f.work)
  assert.deepEqual({ turns,reviews },{ turns: 1,reviews: 0 })
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'partial')
  assert.match(JSON.stringify(f.result().committed?.envelope.goalOutcome.gaps),/remains unknown/)
})

it('performs only the necessary tool round trip before direct delivery',async () => {
  const f = fixture('Read the source.'); let turns = 0,reads = 0,reviews = 0
  const load = f.host.loadContext
  f.host.loadContext = async work => ({ ...await load(work),tools: [{ name: 'source__read',action: 'source.read',effect: 'read',approval: false,
    description: 'Read the source',parameters: { type: 'object',properties: {},additionalProperties: false } }] })
  f.host.executeAction = async (_work,action) => action.action === 'source.read'
    ? (reads++,{ ok: true,value: { answer: 42 } }) : { ok: true,value: { requestVersion: 1,pending: [],truncated: false } }
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async () => { reviews++; throw new Error('unexpected semantic review') },
    run: async request => {
      if (++turns === 1) return { text: '',output: [{ type: 'function_call',callId: 'read',name: 'source__read',arguments: '{}' }],usage }
      assert.match(JSON.stringify(request.items),/42/)
      return { text: 'The source says 42.',output: [],usage }
    } }
  await new AgentRuntime(f.host,model,kernel).runWork(f.work)
  assert.deepEqual({ turns,reads,reviews },{ turns: 2,reads: 1,reviews: 0 })
  assert.equal(f.result().committed?.body,'The source says 42.')
})

it('freezes explicit semantic review mode and rejects legacy or changed bindings',async () => {
  for (const mode of ['changed','legacy','unbound'] as const) {
    const f = fixture(); let turns = 0
    const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
      structured: async () => ({ model: 'synthetic',usage,value: { missing: [] } }),
      run: async () => { turns++; return { text: 'A complete answer.',output: [],usage } } }
    await new AgentRuntime(f.host,model,kernel).runWork(f.work)
    const binding = f.steps.find(step => step.kind === 'runtime.binding')!
    assert.equal(binding.input['semanticReview'],'selective')
    if (mode === 'legacy') delete binding.input['semanticReview']
    if (mode === 'unbound') f.steps.splice(f.steps.indexOf(binding),1)
    f.work.fence++
    await new AgentRuntime(f.host,model,kernel,{ semanticReview: mode === 'changed' ? 'required' : 'selective' }).runWork(f.work)
    assert.equal(turns,1,'incompatible mode must fail before a model call')
    assert.equal(f.result().completion?.status,'failed')
  }
})


const selectedScope = { id: 'visual-authoring.v1',rubric: 'Review only whether the current human request requires creating the selected visual workflow result, and whether that due result was actually delivered. A reference-only question has no authoring gap.' }
for (const missing of [false,true]) it(`runs one focused review only for a trusted selected workflow (missing=${missing})`,async () => {
  const f = fixture(); let turns = 0,reviews = 0
  f.host.verifyCandidate = async (_work,candidate) => ({ candidateHash: candidateHash(candidate),requestVersion: candidate.requestVersion,records: [],
    ...(turns === 1 ? { semanticReview: selectedScope } : {}) })
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async request => { reviews++; assert.match(request.instructions,/Review only whether the current human request/)
      assert.equal((request.input as { semanticReview: { id: string } }).semanticReview.id,selectedScope.id)
      return { model: 'synthetic',usage,value: { missing: missing ? [{ quote: original,reason: 'The selected workflow result was not created.' }] : [] } } },
    run: async () => { turns++; return { text: turns === 1 ? 'Selected workflow answer.' : 'The requested result is delivered.',output: [],usage } } }
  await new AgentRuntime(f.host,model,kernel).runWork(f.work)
  assert.deepEqual({ turns,reviews },{ turns: missing ? 2 : 1,reviews: 1 })
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'satisfied')
  const review = JSON.parse(f.steps.findLast(step => step.kind === 'runtime.review' && step.output !== undefined)!.output!)
  assert.equal(review.semanticReview.id,selectedScope.id)
  assert.match(review.semanticReview.rubricSha256,/^[a-f0-9]{64}$/)
})

it('keeps a trusted required workflow review partial when semantic review is explicitly disabled',async () => {
  const f = fixture(); let turns = 0,reviews = 0
  f.host.verifyCandidate = async (_work,candidate) => ({ candidateHash: candidateHash(candidate),requestVersion: candidate.requestVersion,records: [],semanticReview: selectedScope })
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async () => { reviews++; throw new Error('explicit disabled means zero evaluator calls') },
    run: async () => { turns++; return { text: 'The requested result could not be confirmed.',output: [],usage } } }
  await new AgentRuntime(f.host,model,kernel,{ semanticReview: 'disabled' }).runWork(f.work)
  assert.deepEqual({ turns,reviews },{ turns: 1,reviews: 0 })
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'partial')
  assert.match(JSON.stringify(f.result().committed?.envelope.goalOutcome.gaps),/required.*review.*disabled/i)
})

it('fails closed on malformed trusted review scope without a model router or evaluator',async () => {
  const f = fixture(); let turns = 0,reviews = 0
  f.host.verifyCandidate = async (_work,candidate) => ({ candidateHash: candidateHash(candidate),requestVersion: candidate.requestVersion,records: [],semanticReview: { id: '',rubric: '' } })
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async () => { reviews++; throw new Error('invalid scope cannot invoke review') },
    run: async () => { turns++; return { text: 'The selected workflow could not be verified.',output: [],usage } } }
  await new AgentRuntime(f.host,model,kernel).runWork(f.work)
  assert.deepEqual({ turns,reviews },{ turns: 1,reviews: 0 })
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'partial')
})


for (const recover of [false,true]) it(`retains a previously unresolved selected scope without another judge or rewrite (recover=${recover})`,async () => {
  const f = fixture(); let turns = 0,reviews = 0
  const pause = new AbortController(),save = f.host.saveStep
  if (recover) f.host.saveStep = async (work,step) => { await save(work,step); if (step.kind === 'runtime.review' && step.output !== undefined) pause.abort() }
  f.host.verifyCandidate = async (_work,candidate) => ({ candidateHash: candidateHash(candidate),requestVersion: candidate.requestVersion,records: [],semanticReview: selectedScope })
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async () => { reviews++; return { model: 'synthetic',usage,value: { missing: [{ quote: original,reason: 'The selected workflow has not produced the required result.' }] } } },
    run: async () => { turns++; return { text: `The workflow remains unavailable (attempt ${turns}).`,output: [],usage } } }
  await new AgentRuntime(f.host,model,kernel).runWork(f.work,recover ? pause.signal : undefined)
  if (recover) {
    assert.equal(f.result().committed,undefined)
    f.host.saveStep = save; f.work.fence++
    await new AgentRuntime(f.host,model,kernel).runWork(f.work)
  }
  assert.deepEqual({ turns,reviews },{ turns: 2,reviews: 1 })
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'partial')
  assert.match(JSON.stringify(f.result().committed?.envelope.goalOutcome.gaps),/previously unresolved.*scope/i)
})

it('does not reuse a previous positive scope review for a different candidate body',async () => {
  const f = fixture(); let turns = 0,reviews = 0
  f.host.verifyCandidate = async (_work,candidate) => ({ candidateHash: candidateHash(candidate),requestVersion: candidate.requestVersion,records: [],semanticReview: selectedScope })
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async () => { reviews++; return { model: 'synthetic',usage,value: { missing: [] } } },
    run: async () => ({ text: ++turns === 1 ? 'A reference explanation.' : 'A changed candidate.',output: [],usage }) }
  await new AgentRuntime(f.host,model,kernel).runWork(f.work)
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'satisfied')
  f.work.fence++
  await new AgentRuntime(f.host,model,kernel).runWork(f.work)
  assert.deepEqual({ turns,reviews },{ turns: 2,reviews: 1 })
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'partial')
})


it('reserves a selected scope before the paid review so interruption cannot purchase another judge',async () => {
  const f = fixture(),pause = new AbortController(); let turns = 0,reviews = 0
  f.host.verifyCandidate = async (_work,candidate) => ({ candidateHash: candidateHash(candidate),requestVersion: candidate.requestVersion,records: [],semanticReview: selectedScope })
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async () => { reviews++; pause.abort(); return { model: 'synthetic',usage,value: { missing: [{ quote: original,reason: 'The workflow has not delivered.' }] } } },
    run: async () => { turns++; return { text: 'The selected workflow remains unavailable.',output: [],usage } } }
  await new AgentRuntime(f.host,model,kernel).runWork(f.work,pause.signal)
  assert.equal(f.result().committed,undefined)
  assert.equal(reviews,1)
  assert.ok(f.steps.some(step => step.kind === 'runtime.review' && step.output === undefined),'scope admission must precede the paid call')
  f.work.fence++
  await new AgentRuntime(f.host,model,kernel).runWork(f.work)
  assert.deepEqual({ turns,reviews },{ turns: 2,reviews: 1 })
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'partial')
})
