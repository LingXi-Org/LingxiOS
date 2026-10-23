import { MemoryModelBudgetStore } from '../src/control-plane/memory-store.js'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { ControlPlaneService } from '../src/control-plane/service.js'
import { MemoryActionLedger, MemoryEventStore, MemorySessionStore, MemoryWorkStore } from '../src/control-plane/memory-store.js'
import { snapshotEvidence } from '../src/context/evidence.js'
import { createResponseEnvelope } from '../src/outcome/envelope.js'
import type { GoalAssessment } from '../src/outcome/assessment.js'
import type { AssistantMessage, SessionRecord } from '../src/protocol/types.js'
import { MemoryStepStore } from '../src/control-plane/steps.js'
import { candidateHash } from '../src/outcome/verification.js'
import { businessActionDeliveryGap, requiresReview } from '../src/outcome/completion.js'

it('uses explicit action delivery as a hard receipt obligation and only uses wording as a conservative review trigger', () => {
  const request = { version: 1 as const, workId: 'w', tenantId: 't', sessionId: 's', authorId: 'u', sourceRef: 'm',
    originalText: 'Notify the teacher.', revisions: [], attachments: [], evidence: snapshotEvidence('w:evidence:1', []), deliveryMode: 'action' as const }
  assert.equal(requiresReview(request, [], []), true)
  assert.match(businessActionDeliveryGap(request, false)!, /no durable successful receipt/)
  assert.equal(businessActionDeliveryGap(request, true), null)
  const { deliveryMode: _mode, ...automatic } = request
  assert.equal(requiresReview({ ...automatic, originalText: '请发送邮件通知老师。' }, [], []), true)
  assert.equal(requiresReview({ ...request, deliveryMode: 'text', originalText: '请解释如何发送邮件。' }, [], []), false)
  for (const deliveryMode of ['auto','text'] as const) {
    const answer = { ...request, mode: 'execute' as const, deliveryMode, originalText: 'What is 17 plus 26?' }
    assert.equal(businessActionDeliveryGap(answer, false), null)
    assert.equal(requiresReview(answer, [], []), true)
  }
  assert.match(businessActionDeliveryGap({ ...automatic, mode: 'execute' }, false)!, /no durable successful receipt/)
  assert.match(businessActionDeliveryGap({ ...request, mode: 'execute' }, false)!, /no durable successful receipt/)
})

it('requires settled actions and a reviewed committed response, and binds delegation to real scoped child work', async () => {
  for (const delegated of [false, true]) {
    const workStore = new MemoryWorkStore(), actions = new MemoryActionLedger()
    let committed: AssistantMessage | null = null
    const fileTool = { name: 'files__save', action: 'files.save', description: 'Save a file.',
      parameters: { type: 'object' as const, properties: {}, additionalProperties: false as const }, effect: 'transaction' as const, approval: false }
    const service = new ControlPlaneService({ modelBudgets: new MemoryModelBudgetStore(), steps: new MemoryStepStore(), work: workStore, actions, sessions: new MemorySessionStore(), events: new MemoryEventStore(),
      tools: [fileTool],
      contextProvider: { loadContext: async () => { throw new Error('unexpected') } },
      capabilityResolver: { resolve: async () => [] }, actionExecutor: { prepare: async () => {}, execute: async () => { throw new Error('unexpected') } },
      delivery: { onEvent: async () => {}, getMessage: async () => committed,
        deliverMessage: async (_work, message) => { committed = structuredClone(message) } } })
    await service.enqueue({ id: 'w', tenantId: 't', principalId: 'u', agentId: 'a', sessionId: 's', triggerRef: 'm', kind: 'turn', lane: 'interactive', meta: { text: 'Create a file.', deliveryMode: 'action' } })
    const work = (await service.claim('worker'))!
    const evidence = snapshotEvidence('w:evidence:1', [])
    const session: SessionRecord = { key: '["t","a","s",null]', tenantId: 't', agentId: 'a', sessionId: 's', history: [], appliedWorkIds: ['w'], revision: 0, compactionEpoch: 0,
      request: { version: 1, workId: 'w', tenantId: 't', sessionId: 's', authorId: 'u', sourceRef: 'm', originalText: 'Create a file.', revisions: [], deliveryMode: 'action', attachments: [], evidence } }
    await service.saveSession(work, session)
    await assert.rejects(service.waitWork(work, {
      status: 'awaiting_approval', approvalId: 'invented', requestVersion: 1, verification: 'not_run',
    }), /durable pending receipt/)
    await assert.rejects(service.waitWork(work, {
      status: 'awaiting_input', question: 'Invented question?', requestVersion: 1, verification: 'not_run',
    }), /durable question receipt/)
    const assessment: GoalAssessment = { status: delegated ? 'delegated' : 'satisfied', ...(delegated ? { taskRef: 'child' } : {}),
      gaps: delegated ? ['Child work is pending'] : [], checks: [{ requirement: 'Create a file.', status: delegated ? 'unknown' : 'met', basis: 'Execution observation' }] }
    const outcome = delegated ? { status: 'delegated' as const, taskRef: 'child', gaps: assessment.gaps, verification: 'not_run' as const, requestVersion: 1 }
      : { status: 'satisfied' as const, verification: 'not_run' as const, requestVersion: 1 }
    const message: AssistantMessage = { version: 2, runId: 'w', agentId: 'a', sessionId: 's', body: 'Result',
      envelope: createResponseEnvelope('Result', outcome, evidence, [], undefined, undefined, assessment) }
    await service.recordEvent(work, { runId: 'w', seq: 1, kind: 'model.completed', stage: 'completed', visibility: 'internal', data: {} })
    await service.recordEvent(work, { runId: 'w', seq: 2, kind: 'model.delta', stage: 'delta', visibility: 'user', data: { partType: 'text', delta: 'Result' } })
    await service.recordEvent(work, { runId: 'w', seq: 3, kind: 'response.assessed', stage: 'completed', visibility: 'internal',
      data: { body: message.body, assessment, goalOutcome: outcome } })
    await assert.rejects(service.complete(work, { status: 'completed', goalOutcome: outcome }),
      delegated ? /waiting requires waitWork/ : /committed assessed response/)
    if (delegated) {
      await assert.rejects(service.commitResult(work, message), /delegated task is not pending/)
      await workStore.enqueue({ id: 'child', tenantId: 't', principalId: 'u', agentId: 'child-agent', sessionId: 's', triggerRef: 'm', kind: 'turn', lane: 'collaboration',
        meta: { parentWorkId: 'w', parentRequestVersion: 1 } })
    } else {
      const action = { runId: 'w', cellId: 'c', callIndex: 0, action: 'files.save', args: {}, idempotencyKey: '["w","c",0]' }
      await actions.reserve(action.idempotencyKey, 'fingerprint', { workId: 'w', tenantId: 't', principalId: 'u', agentId: 'a', sessionId: 's', threadId: null, requestVersion: 1, action })
      await assert.rejects(service.commitResult(work, message), /evidence or artifact records/)
      await actions.record(action.idempotencyKey, { ok: true, value: 'saved' })
      await assert.rejects(service.commitResult(work, message), /evidence or artifact records/)
      const hash = candidateHash({ body: message.body, requestVersion: 1, artifacts: [] })
      await service.saveStep(work, { id: 'review', kind: 'runtime.review', requestVersion: 1,
        input: { workId: work.id, candidateHash: hash }, output: JSON.stringify({ workId: work.id, candidateHash: hash, requestVersion: 1, missing: [] }), artifacts: [] })
    }
    await service.commitResult(work, message)
    if (delegated) await workStore.requestCancel('child')
    if (outcome.status === 'delegated') await service.waitWork(work, outcome)
    else await service.complete(work, { status: 'completed', goalOutcome: outcome })
    assert.deepEqual(workStore.inspect('w')?.goalOutcome, outcome)
  }
})


function semanticFixture() {
  const workStore = new MemoryWorkStore(),steps = new MemoryStepStore(),actions = new MemoryActionLedger()
  let committed: AssistantMessage | undefined
  const sessions = new MemorySessionStore()
  const service = new ControlPlaneService({ modelBudgets: new MemoryModelBudgetStore(),steps,work: workStore,actions,sessions,events: new MemoryEventStore(),
    contextProvider: { loadContext: async () => { throw new Error('unexpected') } },capabilityResolver: { resolve: async () => [] },
    actionExecutor: { prepare: async () => {},execute: async () => { throw new Error('unexpected') } },
    delivery: { onEvent: async () => {},deliverMessage: async (_work,message) => { committed = message } } })
  return { service,steps,actions,committed: () => committed }
}
const bindingInput = (mode: 'disabled' | 'required') => ({ runtime: 'synthetic',harness: null,prompt: 'synthetic',model: null,provider: null,semanticReview: mode })
for (const mode of ['disabled','required','optional','limitation','legacy'] as const) it(`honors explicit semantic review binding at final commit: ${mode}`,async () => {
  const f = semanticFixture(),text = 'Explain gravity and provide an example.'
  await f.service.enqueue({ id: 'w',tenantId: 't',principalId: 'u',agentId: 'a',sessionId: 's',triggerRef: 'm',kind: 'turn',lane: 'interactive',meta: { text } })
  const work = (await f.service.claim('worker'))!,evidence = snapshotEvidence('w:evidence:1',[])
  await f.service.saveSession(work,{ key: '["t","a","s",null]',tenantId: 't',agentId: 'a',sessionId: 's',history: [],appliedWorkIds: ['w'],revision: 0,compactionEpoch: 0,
    request: { version: 1,workId: 'w',tenantId: 't',sessionId: 's',authorId: 'u',sourceRef: 'm',originalText: text,revisions: [],attachments: [],evidence } })
  const input: Record<string,unknown> = bindingInput(mode === 'disabled' ? 'disabled' : 'required')
  if (mode === 'legacy') delete input['semanticReview']
  await f.service.saveStep(work,{ id: 'runtime:binding',kind: 'runtime.binding',requestVersion: 1,input,output: '{}',artifacts: [] })
  const body = 'Gravity attracts masses; a falling ball is an example.'
  const hash = candidateHash({ body,requestVersion: 1,artifacts: [] })
  if (mode === 'optional' || mode === 'limitation') await f.service.saveStep(work,{ id: 'review',kind: 'runtime.review',requestVersion: 1,
    input: { workId: work.id,candidateHash: hash },output: JSON.stringify({ workId: work.id,candidateHash: hash,requestVersion: 1,
      missing: mode === 'optional' ? [{ quote: text,reason: 'Optional extra illustration.',priority: 'optional' }] : [],
      limitations: mode === 'limitation' ? [{ quote: body,requestQuote: text,reason: 'Due result is unavailable.',priority: 'optional' }] : [] }),artifacts: [] })
  const message: AssistantMessage = { version: 2,runId: 'w',agentId: 'a',sessionId: 's',body,
    envelope: createResponseEnvelope(body,{ status: 'satisfied',verification: 'not_run',requestVersion: 1 },evidence) }
  if (mode === 'disabled' || mode === 'optional') { await f.service.commitResult(work,message); assert.equal(f.committed()?.body,body) }
  else await assert.rejects(f.service.commitResult(work,message),/evidence or artifact records/)
})

it('rejects forged or mutated semantic review bindings and keeps native action obligations',async () => {
  const f = semanticFixture(),text = 'Send the message.'
  await f.service.enqueue({ id: 'w',tenantId: 't',principalId: 'u',agentId: 'a',sessionId: 's',triggerRef: 'm',kind: 'turn',lane: 'interactive',meta: { text,deliveryMode: 'action' } })
  const work = (await f.service.claim('worker'))!,evidence = snapshotEvidence('w:evidence:1',[])
  await f.service.saveSession(work,{ key: '["t","a","s",null]',tenantId: 't',agentId: 'a',sessionId: 's',history: [],appliedWorkIds: ['w'],revision: 0,compactionEpoch: 0,
    request: { version: 1,workId: 'w',tenantId: 't',sessionId: 's',authorId: 'u',sourceRef: 'm',originalText: text,deliveryMode: 'action',revisions: [],attachments: [],evidence } })
  for (const step of [
    { id: 'runtime:binding',kind: 'runtime.binding',requestVersion: 1,input: { semanticReview: 'disabled' },output: '{}',artifacts: [] },
    { id: 'replacement-binding',kind: 'runtime.binding',requestVersion: 1,input: bindingInput('disabled'),output: '{}',artifacts: [] },
  ]) await assert.rejects(f.service.saveStep(work,step),/invalid runtime behavior binding/)
  await f.service.saveStep(work,{ id: 'runtime:binding',kind: 'runtime.binding',requestVersion: 1,input: bindingInput('disabled'),output: '{}',artifacts: [] })
  await assert.rejects(f.service.saveStep(work,{ id: 'runtime:binding',kind: 'runtime.binding',requestVersion: 1,input: bindingInput('required'),output: '{}',artifacts: [] }),/step identity changed/)
  const body = 'Sent.'
  await assert.rejects(f.service.commitResult(work,{ version: 2,runId: 'w',agentId: 'a',sessionId: 's',body,
    envelope: createResponseEnvelope(body,{ status: 'satisfied',verification: 'not_run',requestVersion: 1 },evidence) }),/evidence or artifact records/)
  assert.equal(f.committed(),undefined)
})
