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
      if (turns === 2) assert.match(JSON.stringify(request.items),assessment ? /Continue any work/ : /fix the omissions/)
      const body = turns === 1 ? 'The comparison below explains each layer.' : 'The complete comparison is supplied.'
      return assessment ? { text: '',output: [],usage,finalCandidate: JSON.stringify({ body,status: turns === 1 ? 'partial' : 'satisfied',
        gaps: turns === 1 ? ['Comparison not yet created'] : [],checks: [{ requirement: original,status: turns === 1 ? 'unknown' : 'met',basis: 'Fixture' }] }) }
        : { text: body,output: [{ role: 'assistant',content: body }],usage }
    } }
  await new AgentRuntime(f.host,model,kernel).runWork(f.work)
  assert.equal(turns,2)
  assert.equal(reviews,assessment ? 1 : 3)
  assert.equal(f.result().committed?.body,'The complete comparison is supplied.')
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'satisfied')
})

it('bounds repeated omissions and retains truthful partial content',async () => {
  const f = fixture(); let turns = 0
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async request => ({ model: 'reviewer',usage,value: Array.isArray((request.input as { findings?: unknown }).findings)
      ? { deferred: [] } : { missing: [{ quote: original,reason: 'Still missing the requested comparison.' }] } }),
    run: async () => { turns++; return { text: 'A useful partial explanation.',output: [{ role: 'assistant',content: 'A useful partial explanation.' }],usage } } }
  await new AgentRuntime(f.host,model,kernel).runWork(f.work)
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
  await new AgentRuntime(f.host,model,kernel).runWork(f.work)
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
  f.host.verifyCandidate = async (_work,candidate) => { checks++; return { candidateHash: '',requestVersion: candidate.requestVersion,
    records: checks === 1 ? [{ checker: 'resource',status: 'failed',evidence: { reason: 'resource not ready' } }] : [] } }
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async request => ({ model: 'reviewer',usage,value: Array.isArray((request.input as { findings?: unknown }).findings)
      ? { deferred: [] } : { missing: [{ quote: original,reason: 'Peer contribution pending.' }] } }),
    run: async () => { turns++; return { text: '@peer Please check this contribution.',output: [],usage } } }
  await new AgentRuntime(f.host,model,kernel,{ policy }).runWork(f.work)
  assert.equal(turns,2,'resource failure still repairs before peer handoff can commit')
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'partial')
})

// Failure inventory: docs/evidence/loop-331-content-budget/FAILURE-MODEL.md.
const recoveryRequest = 'Explain how a circle\'s area changes when its radius doubles, with concrete examples.'
const recoveryAnswer = 'A circle has area πr². A radius of 1 gives area π, and a radius of 2 gives area 4π. Doubling the radius quadruples the area because both dimensions scale by two.'
const promise = 'I will prepare the explanation and examples.'
function recoveryRuntime(f: ReturnType<typeof fixture>,model: ModelDriver,extra?: number,rootModelBudget: RootModelBudgetOptions = {}) {
  const options: AgentRuntimeOptions = { rootModelBudget,...(extra === undefined ? {} : { additionalContentCorrections: extra }) }
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
  assert.equal(synthetic.counts().reviews,extra === 0 ? 2 : alwaysMissing ? 8 : 3)
  assert.equal(f.result().committed?.envelope.goalOutcome.status,repaired ? 'satisfied' : 'partial')
  assert.equal(f.result().committed?.body,repaired ? recoveryAnswer : promise)
  if (!repaired) assert.match(JSON.stringify(f.result().committed?.envelope.goalOutcome.gaps),/correction budget exhausted/i)
})

for (const limit of ['calls','tokens','cost','deadline'] as const) it(`does not let extra content corrections spend beyond the root ${limit} budget`,async t => {
  const f = fixture(recoveryRequest), synthetic = protocolThenOmission()
  // Each issued attempt uses exactly 100 input + 20 output tokens. The fifth
  // call finishes the first content check, before extra repair could start.
  const model: ModelDriver = { ...synthetic.model,countTokens: () => 100,maxOutputTokens: 20 }
  let settled = 0, now = Date.now()
  if (limit === 'deadline') t.mock.method(Date,'now',() => now)
  const record = f.host.recordModelUsage
  f.host.recordModelUsage = async (...args) => { await record(...args); if (++settled === 5 && limit === 'deadline') now += 1000 }
  await recoveryRuntime(f,model,3,{ maxModelCalls: limit === 'calls' ? 5 : 16,
    maxTokens: limit === 'tokens' ? 600 : 1_000_000,maxCostMicros: limit === 'cost' ? 600 : 1_000_000,
    inputCostMicrosPerMillion: 1_000_000,outputCostMicrosPerMillion: 1_000_000,wallClockMs: limit === 'deadline' ? 1000 : 30_000 }).runWork(f.work)
  assert.deepEqual(synthetic.counts(),{ turns: 3,reviews: 2 })
  assert.equal(settled,5)
  assert.equal(f.result().committed?.envelope.goalOutcome.status,'partial')
  assert.match(JSON.stringify(f.result().committed?.envelope.goalOutcome.gaps),/Model call, token, cost or execution-time budget exhausted/)
})

it('stops on cancellation before issuing the additional content correction',async () => {
  const f = fixture(recoveryRequest), synthetic = protocolThenOmission(); let cancelled = false
  f.host.emitEvent = async (_work,event) => { if (event.kind === 'response.content_checked') cancelled = true }
  f.host.heartbeat = async () => ({ ok: true,cancelRequested: cancelled })
  await recoveryRuntime(f,synthetic.model,3).runWork(f.work)
  assert.deepEqual(synthetic.counts(),{ turns: 3,reviews: 2 })
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
  assert.deepEqual(synthetic.counts(),{ turns: 6,reviews: 8 })
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

it('cannot add an allowance when resuming a previously unbound default execution',async () => {
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
    assert.equal(f.steps.some(step => step.kind === 'runtime.binding'),false)
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
