import { durableProtocol } from './protocol-fixture.js'
import { snapshotEvidence } from '../src/context/evidence.js'
import { textSha256 } from '../src/context/compiler.js'
import { createTaskContract } from '../src/context/task-contract.js'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { HostPort } from '../src/host/port.js'
import type { ModelDriver } from '../src/model/driver.js'
import type { KernelExecutor } from '../src/kernel/manager.js'
import { actionKeyOf, type HostAction, type HostActionResult, type ModelItem, type RunEvent, type SessionRecord, type TurnContext, type WorkCompletion } from '../src/protocol/types.js'
import { MAX_TOOL_OUTPUT_CHARS } from '../src/protocol/constants.js'
import { observationRef } from '../src/context/observations.js'
import { boundedToolOutput } from '../src/runtime/tool.js'
import { AgentRuntime } from '../src/runtime/runtime.js'
import { ApprovalPendingError, ModelDriverError } from '../src/errors.js'
import type { ModelCallObservation } from '../src/runtime/runtime.js'
import { modelPricing, DEFAULT_MODEL_BUDGET } from '../src/model/execution.js'

// The reviewer must see the same prior conversation as generation, but never
// receive the candidate itself as independent historical evidence.
it('grounds a follow-up content review in the conversation supplied to generation', async () => {
  const work: TurnContext['work'] = { id: 'followup-review', tenantId: 't', agentId: 'a', sessionId: 's', kind: 'turn',
    lane: 'interactive', triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'token', meta: { mode: 'execute', deliveryMode: 'auto' } }
  const saved: SessionRecord = { key: '["t","a","s",null]', tenantId: 't', agentId: 'a', sessionId: 's', revision: 1,
    compactionEpoch: 0, appliedWorkIds: [], history: [{ role: 'user', content: 'Our agreed phrase is sapphire-47.' }] }
  let outcome: string | undefined, reviewed = false
  const host: HostPort = { ...durableProtocol(), claimWork: async () => null, heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ work, persona: { name: 'A', role: '', instructions: '' }, capabilities: [],
      messages: [{ ref: 'm', authorId: 'u', authorName: 'U', authorKind: 'human', body: 'What phrase did we agree on?', createdAt: 'now' }] }),
    loadSession: async () => structuredClone(saved), saveSession: async () => {}, emitEvent: async () => {},
    executeAction: async () => ({ ok: true, value: { requestVersion: 1, pending: [], truncated: false } }),
    commitResult: async (_work, message) => { outcome = message.envelope.goalOutcome.status }, completeWork: async () => {}, yieldWork: async () => {} }
  const usage = { available: true, inputTokens: 100, outputTokens: 20 }, body = 'The answer from our conversation is sapphire-47.'
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected') },
    structured: async request => {
      reviewed = true
      const context = JSON.stringify((request.input as { observations?: { conversation?: unknown } }).observations?.conversation ?? [])
      assert.match(context, /Our agreed phrase is sapphire-47/)
      assert.ok(!context.includes(body))
      return { model: 'test', usage, value: { missing: [] } }
    }, run: async () => ({ text: body, usage, output: [{ role: 'assistant', content: body }] }) }
  await new AgentRuntime(host, model, { execute: async () => { throw new Error('unexpected') } }).runWork(work)
  assert.equal(reviewed, true)
  assert.equal(outcome, 'satisfied')
})

// Background reservations must not consume a foreground reply's budget; completed
// summaries must survive the final reply instead of being discarded at shutdown.
for (const [maxTokens, window, historyChars] of [[110_000, 128_000, 80_000], [1_000_000, 128_000, 80_000], [1_000_000, 1_000_000, 400_000]]) it(`prioritizes replies and saves ready summaries (budget=${maxTokens}, window=${window})`, async () => {
  const work: TurnContext['work'] = { id: 'early-summary', tenantId: 't', agentId: 'a', sessionId: 's', kind: 'turn',
    lane: 'interactive', triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'token' }
  let saved: SessionRecord = { key: '["t","a","s",null]', tenantId: 't', agentId: 'a', sessionId: 's', revision: 1,
    compactionEpoch: 0, appliedWorkIds: [], history: [{ role: 'user', content: 'x'.repeat(historyChars!) }] }
  let body = ''
  const host: HostPort = { ...durableProtocol(), claimWork: async () => null, heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ work, persona: { name: 'A', role: '', instructions: '' }, capabilities: [],
      messages: [{ ref: 'm', authorId: 'u', authorName: 'U', authorKind: 'human', body: 'Continue.', createdAt: 'now' }] }),
    loadSession: async () => structuredClone(saved), saveSession: async (_work, value) => { saved = structuredClone(value) },
    emitEvent: async () => {}, executeAction: async () => ({ ok: true, value: { requestVersion: 1, pending: [], truncated: false } }),
    commitResult: async (_work, message) => { body = message.body }, completeWork: async () => {}, yieldWork: async () => {} }
  const usage = { available: true, inputTokens: 100, outputTokens: 20 }
  const model: ModelDriver = { contextWindowTokens: window!, maxOutputTokens: 8192,
    compact: async () => ({ model: 'test', usage,
      value: JSON.stringify({ observedResults: 'Earlier observations.', decisions: '', remainingWork: 'Continue.', uncertainties: '' }) }),
    structured: async () => ({ model: 'test', usage, value: { missing: [] } }),
    run: async () => { await new Promise<void>(resolve => setImmediate(resolve))
      return { text: 'Continued.', usage, output: [{ role: 'assistant', content: 'Continued.' }] } } }
  await new AgentRuntime(host, model, { execute: async () => { throw new Error('unexpected') } }, { rootModelBudget: { maxTokens: maxTokens! } }).runWork(work)
  assert.equal(body, 'Continued.')
  assert.equal(saved.compactionEpoch, maxTokens! > 110_000 ? 1 : 0)
})

// A completed background summary may still leave the newly appended turn above
// the hard limit; it must be compacted again before the next provider request.
it('rechecks the hard budget after installing a background summary with new output', async () => {
  const work: TurnContext['work'] = { id: 'append-recovery', tenantId: 't', agentId: 'a', sessionId: 's', kind: 'turn',
    lane: 'interactive', triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'token' }
  let saved: SessionRecord = { key: '["t","a","s",null]', tenantId: 't', agentId: 'a', sessionId: 's', revision: 1,
    compactionEpoch: 0, appliedWorkIds: [], history: Array.from({ length: 50 }, () => ({ role: 'user', content: 'x'.repeat(2000) })) }
  let body = '', turns = 0, summaries = 0
  const host: HostPort = { ...durableProtocol(), claimWork: async () => null, heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ work, persona: { name: 'A', role: '', instructions: '' }, capabilities: [],
      messages: [{ ref: 'm', authorId: 'u', authorName: 'U', authorKind: 'human', body: 'Continue.', createdAt: 'now' }] }),
    loadSession: async () => structuredClone(saved), saveSession: async (_work, value) => { saved = structuredClone(value) },
    emitEvent: async () => {}, executeAction: async () => ({ ok: true, value: { requestVersion: 1, pending: [], truncated: false } }),
    commitResult: async (_work, message) => { body = message.body }, completeWork: async () => {}, yieldWork: async () => {} }
  const usage = { available: true, inputTokens: 100, outputTokens: 20 }
  const model: ModelDriver = { contextWindowTokens: 128_000, maxOutputTokens: 8192,
    compact: async () => { summaries++; return { model: 'test', usage,
      value: JSON.stringify({ observedResults: 'Earlier observations.', decisions: '', remainingWork: 'Continue.', uncertainties: '' }) } },
    structured: async () => ({ model: 'test', usage, value: { missing: [] } }),
    run: async () => {
      await new Promise<void>(resolve => setImmediate(resolve))
      if (++turns === 1) return { text: '', usage, output: [{ role: 'assistant', content: 'y'.repeat(80000) },
        { type: 'function_call', callId: 'read', name: 'ipython', arguments: '{"code":"print(1)"}' }] }
      return { text: 'Continued.', usage, output: [{ role: 'assistant', content: 'Continued.' }] }
    } }
  await new AgentRuntime(host, model, { execute: async () => ({ executionId: 'e', stdout: '1', stderr: '', result: null,
    artifacts: [], hostActions: [], directives: [], durationMs: 1, truncated: false }) }).runWork(work)
  assert.equal(body, 'Continued.')
  assert.ok(summaries >= 2)
  assert.ok(saved.compactionEpoch >= 2)
})

for (const tail of [1, 20]) for (const failure of [false, true]) it(`restores an oversized session with atomic compaction (tail=${tail}, failure=${failure})`, async () => {
  const work: TurnContext['work'] = { id: 'recover', tenantId: 't', agentId: 'a', sessionId: 's', kind: 'turn',
    lane: 'interactive', triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'token' }
  let saved: SessionRecord = { key: '["t","a","s",null]', tenantId: 't', agentId: 'a', sessionId: 's', revision: 1,
    compactionEpoch: 0, appliedWorkIds: [], history: [{ role: 'user', content: 'private-marker'.repeat(20_000) },
      ...Array.from({ length: tail }, () => ({ role: 'user' as const, content: 'Recent observation' }))] }
  const observations: ModelCallObservation[] = [], failed: RunEvent[] = []
  let body = '', completed: WorkCompletion | undefined, chunks = 0
  const host: HostPort = { ...durableProtocol(value => observations.push(value)),
    claimWork: async () => null, heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ work, persona: { name: 'A', role: '', instructions: '' }, capabilities: [],
      messages: [{ ref: 'm', authorId: 'u', authorName: 'U', authorKind: 'human', body: 'Continue the explanation.', createdAt: 'now' }] }),
    executeAction: async () => ({ ok: true, value: { requestVersion: 1, pending: [], truncated: false } }),
    loadSession: async () => structuredClone(saved), saveSession: async (_work, value) => { saved = structuredClone(value) },
    emitEvent: async (_work, event) => { if (event.kind === 'run.failed') failed.push(event) },
    commitResult: async (_work, message) => { body = message.body },
    completeWork: async (_work, value) => { completed = value }, yieldWork: async () => {} }
  const usage = { available: true, inputTokens: 100, outputTokens: 20 }
  const model: ModelDriver = { contextWindowTokens: 128_000, maxOutputTokens: 8192,
    compact: async () => { chunks++; return { model: 'test', usage, value: failure && chunks === 2 ? 'private-marker invalid JSON'
      : JSON.stringify({ observedResults: 'Earlier context', decisions: '', remainingWork: 'Continue the explanation.', uncertainties: '' }) } },
    structured: async () => ({ model: 'test', usage, value: { missing: [] } }),
    run: async request => {
      assert.doesNotMatch(JSON.stringify(request.items), /private-marker/)
      return { text: 'Explanation continued.', output: [{ role: 'assistant', content: 'Explanation continued.' }], usage }
    } }
  await new AgentRuntime(host, model, { execute: async () => { throw new Error('unexpected Python') } },
    { performance: { asyncCompaction: true } }).runWork(work)
  assert.ok(chunks >= 2)
  assert.equal(observations.filter(call => call.purpose === 'compaction').length, chunks)
  if (failure) {
    assert.equal(completed?.status, 'failed')
    assert.equal(body, '')
    assert.equal(saved.compactionEpoch, 0)
    assert.match(JSON.stringify(saved.history[0]), /private-marker/)
    assert.equal((failed[0]?.data['compactionDiagnostics'] as { reason: string }).reason, 'invalid_summary')
    assert.doesNotMatch(JSON.stringify(failed), /private-marker/)
  } else {
    assert.equal(body, 'Explanation continued.')
    assert.equal(saved.compactionEpoch, 1)
    assert.equal(failed.length, 0)
  }
})

it('reports every processor model call to the product ledger with durable work scope', async () => {
  const work: TurnContext['work'] = { id: 'ledger-work', tenantId: 'tenant', agentId: 'agent', sessionId: 'room',
    threadId: 'thread', principalId: 'human', kind: 'memory_synthesis', lane: 'background', triggerRef: 'source',
    fence: 3, homeEpoch: 1, leaseToken: 'secret' }
  const observations: ModelCallObservation[] = []
  let completed: WorkCompletion | undefined
  const host: HostPort = { ...durableProtocol(value => observations.push(value)), claimWork: async () => null, heartbeat: async () => ({ ok: true }),
    loadContext: async () => { throw new Error('unexpected context') }, executeAction: async () => ({ ok: true }),
    loadSession: async () => null, saveSession: async () => {}, emitEvent: async () => {}, commitResult: async () => {},
    completeWork: async (_work, value) => { completed = value }, yieldWork: async () => {} }
  const unexpected = async () => { throw new Error('unexpected model call') }
  const model: ModelDriver = { modelId: 'model-v1', run: unexpected, compact: unexpected,
    structured: async () => ({ value: { ok: true }, model: 'model-v1',
      usage: { available: true, inputTokens: 11, outputTokens: 7 } }) }
  const runtime = new AgentRuntime(host, model, { execute: unexpected })
  runtime.registerProcessor('memory_synthesis', { process: async (_work, context) => { await context.model.structured({ instructions: 'i', input: {} }) } })
  await runtime.runWork(work)
  assert.equal(completed?.status, 'completed')
  assert.deepEqual(observations.map(({ latencyMs: _latencyMs, elapsedMs: _elapsedMs, ...value }) => value), [{
    instructionsSha256: textSha256('i'),
    attempt: 1, callId: 'ledger-work:3:model:1', purpose: 'structured', workId: 'ledger-work', tenantId: 'tenant',
    agentId: 'agent', sessionId: 'room', threadId: 'thread', principalId: 'human', model: 'model-v1',
    usage: { available: true, inputTokens: 11, outputTokens: 7 }, status: 'succeeded',
    cost: { amountMicros: 0, usage: 'measured', pricing: modelPricing(DEFAULT_MODEL_BUDGET) },
  }])
  assert.ok(observations[0]!.latencyMs >= 0)
  assert.ok(observations[0]!.elapsedMs! >= observations[0]!.latencyMs)
})

it('blocks a forged ipython call at the runtime boundary when code execution is disabled', async () => {
  const work: TurnContext['work'] = { id: 'no-code', tenantId: 't', agentId: 'a', sessionId: 's', principalId: 'u',
    kind: 'turn', lane: 'interactive', triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'token', meta: { codeExecution: 'disabled' } }
  let turns = 0, kernelCalls = 0
  let committed: import('../src/protocol/types.js').AssistantMessage | undefined
  const host: HostPort = { ...durableProtocol(), claimWork: async () => null, heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ work, persona: { name: 'A', role: '', instructions: '' }, capabilities: [],
      messages: [{ ref: 'm', authorId: 'u', authorName: 'U', authorKind: 'human', body: 'Explain why 2 + 2 = 4 without executing code.', createdAt: 'now' }] }),
    executeAction: async (_work, action) => {
      assert.equal(action.action, 'task.inspect')
      return { ok: true, value: { requestVersion: 1, pending: [], truncated: false, completedBusinessAction: false } }
    }, loadSession: async () => null, saveSession: async () => {}, emitEvent: async () => {},
    commitResult: async (_work, message) => { committed = message }, completeWork: async () => {}, yieldWork: async () => {} }
  const usage = { available: false, inputTokens: 0, outputTokens: 0 }
  const model: ModelDriver = {
    compact: async () => { throw new Error('unexpected compaction') },
    structured: async () => ({ value: { missing: [] }, model: 'reviewer', usage }),
    run: async request => {
      turns++
      assert.equal(request.codeExecution, 'disabled')
      if (turns === 1) return { text: '', output: [{ type: 'function_call', callId: 'forged', name: 'ipython', arguments: '{"code":"print(4)"}' }], usage }
      assert.match(JSON.stringify(request.items), /Python execution is disabled/)
      return { text: '2 + 2 = 4 by elementary arithmetic.', output: [{ role: 'assistant', content: '2 + 2 = 4 by elementary arithmetic.' }], usage }
    },
  }
  const kernel: KernelExecutor = { execute: async () => {
    kernelCalls++
    throw new Error('kernel must not start when code execution is disabled')
  } }
  await new AgentRuntime(host, model, kernel).runWork(work)
  assert.equal(turns, 2)
  assert.equal(kernelCalls, 0)
  assert.equal(committed?.body, '2 + 2 = 4 by elementary arithmetic.')
})

it('cannot turn an action-mode request into success without a durable successful business receipt', async () => {
  const work: TurnContext['work'] = { id: 'action-required', tenantId: 't', agentId: 'a', sessionId: 's', principalId: 'u',
    kind: 'turn', lane: 'interactive', triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'token', meta: { deliveryMode: 'action' } }
  let committed: import('../src/protocol/types.js').AssistantMessage | undefined
  const host: HostPort = { ...durableProtocol(), claimWork: async () => null, heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ work, persona: { name: 'A', role: '', instructions: '' }, capabilities: [],
      messages: [{ ref: 'm', authorId: 'u', authorName: 'U', authorKind: 'human', body: 'Notify the teacher.', createdAt: 'now' }] }),
    executeAction: async (_work, action) => {
      assert.equal(action.action, 'task.inspect')
      return { ok: true, value: { requestVersion: 1, pending: [], truncated: false, completedBusinessAction: false } }
    }, loadSession: async () => null, saveSession: async () => {}, emitEvent: async () => {},
    commitResult: async (_work, message) => { committed = message }, completeWork: async () => {}, yieldWork: async () => {} }
  const usage = { available: false, inputTokens: 0, outputTokens: 0 }
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async () => ({ value: { missing: [] }, model: 'reviewer', usage }),
    run: async () => ({ text: 'Done.', output: [{ role: 'assistant', content: 'Done.' }], usage }) }
  await new AgentRuntime(host, model, { execute: async () => { throw new Error('unexpected kernel') } }).runWork(work)
  assert.equal(committed?.envelope.goalOutcome.status, 'partial')
  assert.match(JSON.stringify(committed?.envelope.goalOutcome.gaps), /no durable successful receipt/)
})

for (const format of ['object', 'plain text'] as const) it(`preserves ${format} content and observed artifacts when assessment correction is exhausted`, async () => {
  const work: TurnContext['work'] = { id: 'w', tenantId: 't', agentId: 'a', sessionId: 's', kind: 'turn', lane: 'interactive', triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'token' }
  const artifact = { path: 'answer.json', size: 12, mime: 'application/json', sha256: 'a'.repeat(64) }
  let turns = 0, committed = false
  const host: HostPort = { ...durableProtocol(), claimWork: async () => null, heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ work, persona: { name: 'A', role: '', instructions: '' }, capabilities: [],
      messages: [{ ref: 'm', authorId: 'u', authorName: 'U', authorKind: 'human', body: 'Create a file.', createdAt: 'now' }] }),
    executeAction: async () => ({ ok: true }), loadSession: async () => null, saveSession: async () => {}, emitEvent: async () => {},
    commitResult: async (_work, message) => {
      assert.equal(message.envelope.goalOutcome.status, 'partial')
      assert.equal(message.body, 'File created.')
      assert.deepEqual(message.envelope.artifacts, [artifact])
      assert.equal(message.envelope.assessment, undefined)
      assert.match(JSON.stringify(message.envelope.goalOutcome.gaps), format === 'object' ? /protocol correction exhausted/ : /unavailable|unexpected/)
      committed = true
    }, completeWork: async () => {}, yieldWork: async () => {} }
  const unexpected = async () => { throw new Error('unexpected auxiliary call') }
  const model: ModelDriver = { structured: unexpected, compact: unexpected, run: async () => {
    const usage = { available: false, inputTokens: 0, outputTokens: 0 }
    if (++turns === 1) return { usage, text: '', output: [{ type: 'function_call', callId: 'create', name: 'ipython', arguments: '{"code":"create_file()"}' }] }
    const candidate = format === 'plain text' ? 'File created.' : JSON.stringify({ body: 'File created.', status: 'satisfied', checks: [], gaps: [] })
    return { usage, text: candidate, output: [{ role: 'assistant', content: candidate }], ...(format === 'object' ? { finalCandidate: candidate } : {}) }
  } }
  await new AgentRuntime(host, model, { execute: async () => ({ executionId: 'execution', stdout: '', stderr: '', result: null,
    artifacts: [artifact], directives: [], truncated: false, durationMs: 1 }) }).runWork(work)
  assert.equal(turns, format === 'object' ? 4 : 2)
  assert.equal(committed, true)
})

it('continues an actionable partial candidate before committing its result', async () => {
  const work: TurnContext['work'] = { id: 'w', tenantId: 't', agentId: 'a', sessionId: 's', kind: 'turn', lane: 'interactive', triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'token' }
  let turns = 0, executed = 0, body = ''
  const host: HostPort = { ...durableProtocol(), claimWork: async () => null, heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ work, persona: { name: 'A', role: '', instructions: '' }, capabilities: [],
      messages: [{ ref: 'm', authorId: 'u', authorName: 'U', authorKind: 'human', body: 'Create a file.', createdAt: 'now' }] }),
    executeAction: async () => ({ ok: true, value: { requestVersion: 1, pending: [], truncated: false } }),
    loadSession: async () => null, saveSession: async () => {}, emitEvent: async () => {},
    commitResult: async (_work, message) => { assert.equal(executed, 1); body = message.body },
    completeWork: async () => {}, yieldWork: async () => {} }
  const unexpected = async () => { throw new Error('unexpected auxiliary call') }
  const model: ModelDriver = { structured: unexpected, compact: unexpected, run: async request => {
    turns++
    const usage = { available: false, inputTokens: 0, outputTokens: 0 }
    if (turns === 2) {
      assert.match(JSON.stringify(request.items), /Continue any work/)
      return { text: '', output: [{ type: 'function_call', callId: 'create', name: 'ipython', arguments: '{"code":"create_file()"}' }], usage }
    }
    return { text: '', output: [], finalCandidate: JSON.stringify({ body: turns === 1 ? 'I will create it.' : 'File created.',
      status: turns === 1 ? 'partial' : 'satisfied', gaps: turns === 1 ? ['File has not been created yet'] : [],
      checks: [{ requirement: 'Create a file.', status: turns === 1 ? 'unknown' : 'met', basis: turns === 1 ? 'Pending execution' : 'Execution completed' }] }), usage }
  } }
  await new AgentRuntime(host, model, { execute: async () => {
    executed++
    return { executionId: 'execution', stdout: '', stderr: '', result: null, artifacts: [], directives: [], truncated: false, durationMs: 1 }
  } }).runWork(work)
  assert.equal(turns, 3)
  assert.equal(body, 'File created.')
})

// A public contribution must commit before another member can work; continuing
// the missing whole-goal requirements here prevents ordinary mention dispatch.
for (const assessmentStatus of ['partial', 'satisfied'] as const) it(`commits one public contribution without claiming the unfinished goal (${assessmentStatus})`, async () => {
  const work: TurnContext['work'] = { id: 'public-turn', tenantId: 't', agentId: 'a', sessionId: 's', kind: 'turn',
    lane: 'interactive', triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'token',
    meta: { conversationTurn: true, mode: 'execute', codeExecution: 'disabled' },
    conversation: { conversationId: 'room', policyVersion: 1, source: { messageId: 'm', version: 1 },
      audience: { visibility: 'conversation', participantIds: ['u','a','b'] }, internal: false } }
  let turns = 0, reviews = 0
  let committed: import('../src/protocol/types.js').AssistantMessage | undefined
  const original = 'Compute and independently verify the result.'
  const host: HostPort = { ...durableProtocol(), claimWork: async () => null, heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ work, persona: { name: 'A', role: '', instructions: '' }, capabilities: [],
      messages: [{ ref: 'm', authorId: 'u', authorName: 'U', authorKind: 'human', body: original, createdAt: 'now' }] }),
    executeAction: async () => ({ ok: true, value: { requestVersion: 1, pending: [], truncated: false } }),
    loadSession: async () => null, saveSession: async () => {}, emitEvent: async () => {},
    commitResult: async (_work, message) => { committed = message }, completeWork: async () => {}, yieldWork: async () => {} }
  const usage = { available: false, inputTokens: 0, outputTokens: 0 }
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async request => {
      reviews++
      if (Array.isArray((request.input as { findings?: unknown }).findings)) return { value: { deferred: [] }, model: 'reviewer', usage }
      return { value: { missing: [{ quote: 'independently verify', reason: 'Peer verification is still pending' }] }, model: 'reviewer', usage }
    },
    run: async () => { turns++; return { text: '', output: [], usage, finalCandidate: JSON.stringify({
      body: '@b Please independently verify the calculation.', status: assessmentStatus,
      gaps: assessmentStatus === 'partial' ? ['Peer verification is pending'] : [],
      checks: [{ requirement: original, status: assessmentStatus === 'partial' ? 'unknown' : 'met', basis: 'Contribution only' }],
    }) } },
  }
  await new AgentRuntime(host, model, { execute: async () => { throw new Error('unexpected kernel') } }).runWork(work)
  assert.equal(turns, 1)
  assert.equal(reviews, 2)
  assert.equal(committed?.body, '@b Please independently verify the calculation.')
  assert.equal(committed?.envelope.goalOutcome.status, 'partial')
  assert.match(JSON.stringify(committed?.envelope.goalOutcome.gaps), /Peer verification is still pending/)
})

it('drops optional recalled memory before allowing it to crowd out the original request', async () => {
  const work: TurnContext['work'] = { id: 'w', tenantId: 't', agentId: 'a', sessionId: 's', kind: 'turn', lane: 'interactive', triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'token' }
  const original = 'Original requirement '.repeat(200)
  let committed = false
  let omitted = false
  const host: HostPort = { ...durableProtocol(),
    claimWork: async () => null, heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ work, persona: { name: 'A', role: '', instructions: '' }, capabilities: [],
      messages: [{ ref: 'm', authorId: 'u', authorName: 'U', authorKind: 'human', body: original, createdAt: 'now' }],
      memory: { id: 'large-memory', status: 'available', omitted:{core:0,directory:0,recalled:0,strategies:0},core:[],directory:[],recalled:[],
        strategies:[{body:'optional memory '.repeat(750)}],budget:{ratio:0.08,maxTokens:8000},retrieval:['keyword'] } }),
    executeAction: async (_work, action) => {
      assert.equal(action.action, 'task.inspect')
      return { ok: true, value: { requestVersion: 1, pending: [], truncated: false } }
    }, loadSession: async () => null, saveSession: async () => {},
    emitEvent: async (_work, event) => { if (event.kind === 'model.started') {
      omitted=event.data['memoryOmittedForBudget']===true || Number((event.data['memorySnapshot'] as {omitted?:{strategies:number}}|undefined)?.omitted?.strategies)>0
    } },
    commitResult: async (_work, message) => {
      assert.equal(message.body, 'Answer.')
      assert.deepEqual(message.envelope.goalOutcome, { status: 'satisfied', verification: 'not_run', requestVersion: 1 })
      committed = true
    }, completeWork: async () => {}, yieldWork: async () => {},
  }
  const unexpected = async () => { throw new Error('unexpected auxiliary call') }
  const model: ModelDriver = {
    run: async request => {
      assert.ok(request.items.some(item => 'role' in item && item.content.includes(original)))
      assert.doesNotMatch(JSON.stringify(request.items), /optional memory/)
      return { text: '', output: [], finalCandidate: JSON.stringify({
        body: 'Answer.', status: 'satisfied', gaps: [], checks: [{ requirement: 'Original requirement', status: 'met', basis: 'Answer supplied.' }],
      }), usage: { available: false, inputTokens: 0, outputTokens: 0 } }
    }, structured: unexpected, compact: unexpected,
  }
  await new AgentRuntime(host, model, { execute: unexpected }, { compaction: { contextWindowTokens: 30_000 } }).runWork(work)
  assert.equal(committed, true)
  assert.equal(omitted, true)
})

it('reviews complex candidates against original requirements, bounds corrections and discards reviews invalidated by steering', async () => {
  for (const mode of ['fixed', 'exhausted', 'steered', 'invalid'] as const) {
    const work: TurnContext['work'] = { id: 'w', tenantId: 't', agentId: 'a', sessionId: 's', kind: 'turn', lane: 'interactive', triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'token' }
    const originalText = 'Compare both options and include costs.'
    const resourceChecks = [{ actionKey: 'recorded-check', result: { ok: true, value: {
      scope: 'observed_resource_fields', requestVersion: 1, action: 'resource.read', args: { id: 'r' },
      status: 'pass', expected: { cost: 10 }, observed: { cost: 10 },
    } } }]
    let session: SessionRecord = { key: '["t","a","s",null]', tenantId: 't', agentId: 'a', sessionId: 's', revision: 0, compactionEpoch: 0,
      history: [], appliedWorkIds: ['w'], request: { version: 1, workId: 'w', tenantId: 't', sessionId: 's', authorId: 'u', sourceRef: 'm',
        originalText, revisions: [], attachments: [], evidence: snapshotEvidence('e', []), resourceChecks,
        contract: createTaskContract(originalText, 1, { deliverables: ['Compare options'], constraints: [], actions: [], acceptance: ['Comparison provided'] }) } }
    let reviews = 0
    let turns = 0
    let body = ''
    let completion: WorkCompletion | undefined
    const deltas: string[] = []
    const host: HostPort = { ...durableProtocol(),
      claimWork: async () => null,
      heartbeat: async () => ({ ok: true, steer: mode === 'steered' && reviews ? [{ id: 'r', text: 'Just say hello.', createdAt: 'now' }] : [] }),
      loadContext: async () => ({ work, persona: { name: 'A', role: '', instructions: '' }, capabilities: [],
        messages: [{ ref: 'm', authorId: 'u', authorName: 'U', authorKind: 'human', body: originalText, createdAt: 'now' }] }),
      executeAction: async (_work, action) => {
        if (action.action === 'task.inspect') return { ok: true, value: { requestVersion: session.request!.revisions.length + 1, pending: [], truncated: false } }
        assert.equal(action.action, 'task.check_resource')
        return { ok: true, value: { ...resourceChecks[0]!.result.value, status: 'fail', observed: { cost: 20 } } }
      }, loadSession: async () => structuredClone(session),
      saveSession: async (_work, value) => { session = structuredClone(value) },
      emitEvent: async (_work, event) => { if (event.kind === 'model.delta') deltas.push(String(event.data['delta'])) },
      commitResult: async (_work, message) => {
        body = message.body
        completion = { status: 'completed', goalOutcome: message.envelope.goalOutcome }
        assert.notEqual(message.envelope?.goalOutcome.verification, 'passed')
        assert.deepEqual(message.envelope?.resourceChecks?.[0], resourceChecks[0])
        assert.equal(message.envelope?.resourceChecks?.length, mode === 'exhausted' ? 4 : mode === 'fixed' ? 3 : 2)
      },
      completeWork: async (_work, value) => { completion = value }, yieldWork: async () => {},
    }
    const usage = { available: false, inputTokens: 0, outputTokens: 0 }
    const model: ModelDriver = {
      run: async request => {
        turns++
        assert.match(JSON.stringify(request.items), /Recorded resource observations/)
        if (turns === 2 && mode !== 'steered') assert.match(JSON.stringify(request.items), /include costs/)
        const text = turns === 1 ? 'Comparison without costs.' : mode === 'steered' ? 'Hello.' : 'Comparison with costs.'
        return { text: '', output: [], finalCandidate: JSON.stringify({
          body: text, status: 'satisfied', gaps: [], checks: [{ requirement: mode === 'steered' && turns === 2 ? 'Just say hello.' : originalText,
            status: 'met', basis: text }],
        }), usage }
      },
      structured: async request => {
        if (Array.isArray((request.input as { findings?: unknown }).findings)) return { value: { deferred: [] }, model: 'fixture', usage }
        reviews++
        assert.equal((request.input as { originalText: string }).originalText, originalText)
        const observations = (request.input as { resourceChecks: typeof resourceChecks }).resourceChecks
        assert.deepEqual(observations[0], resourceChecks[0])
        assert.equal(observations.length, mode === 'steered' || mode === 'invalid' ? 2 : reviews + 1)
        assert.deepEqual(observations.at(-1)?.result.value.observed, { cost: 20 })
        assert.doesNotMatch(request.instructions, /Mission/)
        return { value: { missing: (mode === 'fixed' || mode === 'steered') && reviews === 2 ? []
          : [{ quote: mode === 'invalid' ? 'Invented requirement' : 'include costs', reason: 'Costs are missing' }] }, model: 'fixture', usage }
      }, compact: async () => { throw new Error('unexpected compaction') },
    }
    await new AgentRuntime(host, model, { execute: async () => { throw new Error('unexpected kernel') } }).runWork(work)
    assert.equal(completion?.status, 'completed')
    assert.deepEqual(deltas, [body])
    assert.equal(reviews, mode === 'exhausted' ? 3 : 2)
    if (mode === 'fixed') {
      assert.equal(completion?.goalOutcome?.status, 'partial')
      assert.equal(body, 'Comparison with costs.')
      assert.match(JSON.stringify(completion?.goalOutcome?.gaps), /did not confirm the expected fields/)
    }
    if (mode === 'exhausted') {
      assert.equal(body, 'Comparison with costs.')
      assert.match(JSON.stringify(completion?.goalOutcome?.gaps), /Content acceptance correction budget exhausted/)
      assert.match(JSON.stringify(completion?.goalOutcome?.gaps), /did not confirm the expected fields/)
      assert.match(JSON.stringify(completion?.goalOutcome?.gaps), /include costs.*Costs are missing/)
    }
    if (mode === 'steered') {
      assert.equal(completion?.goalOutcome?.status, 'satisfied')
      assert.equal(body, 'Hello.')
      assert.equal(completion?.goalOutcome?.requestVersion, 2)
      assert.doesNotMatch(JSON.stringify(completion?.goalOutcome?.gaps ?? []), /Costs are missing|did not confirm the expected fields/)
    }
    if (mode === 'invalid') assert.match(JSON.stringify(completion?.goalOutcome?.gaps), /unavailable or returned invalid/)
  }
})

it('preserves history across prompt upgrades and exposes assigned action receipts with progress text', async () => {
  const context: TurnContext = {
    work: { id: 'w', tenantId: 't', agentId: 'a', sessionId: 's', kind: 'turn', lane: 'interactive', triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'token' },
    persona: { name: 'Assistant', role: 'assistant', instructions: '' }, capabilities: ['files'], messages: [{ ref: 'm', authorId: 'u', authorName: 'User', authorKind: 'human', body: 'Save the requested file.', createdAt: 'now' }],
  }
  context.promptContextCandidate = { version: 3, epoch: 0, assembledAt: '', systemInstructions: '',
    persona: context.persona, capabilities: context.capabilities, sourceVersions: {} }
  const session: SessionRecord = {
    key: '[\"t\",\"a\",\"s\",null]', tenantId: 't', agentId: 'a', sessionId: 's', history: [{ role: 'user', content: 'Preserve this requirement' }], appliedWorkIds: ['w'], revision: 1, compactionEpoch: 0,
    promptContext: { version: 3, epoch: 0, assembledAt: '', systemInstructions: 'Stale prompt v5', persona: context.persona, capabilities: [], sourceVersions: { promptContract: 'prompt-v5' } },
  }
  let completion: WorkCompletion | undefined
  let checkpoint: SessionRecord | undefined
  let calls = 0
  const host: HostPort = { ...durableProtocol(),
    claimWork: async () => null, heartbeat: async () => ({ ok: true }), loadContext: async () => context,
    executeAction: async () => ({ ok: true }), emitEvent: async () => {}, loadSession: async () => session,
    saveSession: async (_work, value) => { checkpoint = structuredClone(value) }, commitResult: async (_work, message) => { assert.equal(message.body, 'Saved.'); completion = { status: 'completed', goalOutcome: message.envelope.goalOutcome } },
    completeWork: async (_work, result) => { completion = result }, yieldWork: async () => {},
  }
  const model: ModelDriver = {
    run: async (request) => {
      assert.deepEqual(request.items[0], { role: 'user', content: 'Preserve this requirement' })
      assert.match(request.instructions, /Runtime authorization/)
      assert.doesNotMatch(request.instructions, /Stale prompt v5/)
      calls++
      const output: ModelItem[] = calls === 1
        ? [{ role: 'assistant', content: 'Saving.' }, { type: 'function_call', callId: 'c', name: 'ipython', arguments: '{"code":"result = host.files.save()"}' }]
        : [{ role: 'assistant', content: 'Saved.' }]
      if (calls === 2) {
        assert.deepEqual(request.items.slice(0, checkpoint!.history.length), checkpoint!.history)
        const receipt = request.items.find(item => 'type' in item && item.type === 'function_call_output')!
        assert.ok('type' in receipt && receipt.type === 'function_call_output')
        assert.deepEqual(JSON.parse(receipt.output).receipts, [{ action: 'files.save', idempotencyKey: '[\"w\",\"hop-1\",0]', result: { ok: true, value: { id: 'document' } } }])
      }
      return { text: calls === 1 ? 'Saving.' : 'Saved.', output, usage: { available: false, inputTokens: 0, outputTokens: 0 } }
    }, structured: async () => { throw new Error('unexpected') }, compact: async () => { throw new Error('unexpected') },
  }
  const kernels: KernelExecutor = { execute: async (_work, _run, _cell, _code, _signal, options) => {
    assert.match(_cell, /^step:/)
    assert.deepEqual(checkpoint?.history.at(-1), { type: 'function_call', callId: 'c', stepId: _cell, name: 'ipython', arguments: '{"code":"result = host.files.save()"}' })
    const action = { runId: 'w', cellId: 'hop-1', callIndex: 0, action: 'files.save', args: {}, idempotencyKey: '[\"w\",\"hop-1\",0]' }
    await options?.onHostAction?.({ stage: 'started', action })
    await options?.onHostAction?.({ stage: 'completed', action, result: { ok: true, value: { id: 'document' } } })
    return { executionId: 'cell', stdout: '', stderr: '', result: null, durationMs: 1, truncated: false, artifacts: [], directives: [] }
  } }
  await new AgentRuntime(host, model, kernels).runWork(context.work)
  assert.deepEqual(completion, { status: 'completed', goalOutcome: { status: 'partial', verification: 'inconclusive', requestVersion: 1, gaps: ['Durable business action reconciliation was unavailable', 'Content check was unavailable or returned invalid findings'] } })
  assert.equal(calls, 2)
  session.history.push({ type: 'function_call', callId: 'interrupted', name: 'ipython', arguments: '{"code":"host.files.save()"}' })
  await new AgentRuntime(host, model, kernels).runWork({ ...context.work, fence: 2 })
  assert.equal(calls, 2)
  assert.equal(completion?.status, 'failed')
  assert.match(completion?.error ?? '', /unresolved tool execution checkpoint/)
  host.recoverCell = async () => [{ action: 'files.save', idempotencyKey: '["w","interrupted",0]', result: {
    ok: false, executionState: 'unknown', error: 'receipt missing',
  } }]
  await new AgentRuntime(host, model, kernels).runWork({ ...context.work, fence: 3 })
  assert.equal(calls, 3)
  assert.equal(completion?.status, 'completed')
})

it('does not spend model-correction budget on provider failures', async () => {
  const work: TurnContext['work'] = { id: 'w', tenantId: 't', agentId: 'a', sessionId: 's', kind: 'turn', lane: 'interactive', triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'token', meta: { text: 'answer' } }
  let calls = 0
  let completion: WorkCompletion | undefined
  const host: HostPort = { ...durableProtocol(),
    claimWork: async () => null, heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ work, persona: { name: '', role: '', instructions: '' }, capabilities: [],
      messages: [{ ref: 'm', authorId: 'u', authorName: 'U', authorKind: 'human', body: 'answer', createdAt: 'now' }] }),
    executeAction: async () => ({ ok: true }), emitEvent: async () => {}, loadSession: async () => null,
    saveSession: async () => {}, commitResult: async () => {}, yieldWork: async () => {},
    completeWork: async (_work, value) => { completion = value },
  }
  const unavailable = async () => { throw new Error('unexpected') }
  const model: ModelDriver = {
    run: async () => { calls++; throw new ModelDriverError('provider unavailable', { kind: 'provider', finishReasons: [] }) },
    structured: unavailable, compact: unavailable,
  }
  await new AgentRuntime(host, model, { execute: unavailable }).runWork(work)
  assert.equal(calls, 3)
  assert.equal(completion?.status, 'failed')
})

it('records approval and input waiting without claiming goal completion or invented delegation', async () => {
  for (const mode of ['approval', 'user', 'handoff'] as const) {
    const work: TurnContext['work'] = { id: 'w', tenantId: 't', agentId: 'a', sessionId: 's', kind: 'turn', lane: 'interactive', triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'token' }
    let completion: WorkCompletion | undefined
    let waiting: import('../src/protocol/outcome.js').WaitingOutcome | undefined
    const host: HostPort = { ...durableProtocol(),
      claimWork: async () => null, heartbeat: async () => ({ ok: true }),
      loadContext: async () => ({ work, persona: { name: '', role: '', instructions: '' }, capabilities: [], messages: [{ ref: 'm', authorId: 'u', authorName: 'User', authorKind: 'human', body: 'Save the requested file.', createdAt: 'now' }] }),
      executeAction: async () => ({ ok: true }), emitEvent: async (_work, event) => { assert.notEqual(event.kind, 'run.completed') },
      loadSession: async () => null, saveSession: async () => {},
      commitResult: async () => { throw new Error('waiting must not commit a final answer') },
      completeWork: async (_work, result) => { completion = result }, yieldWork: async () => {},
      waitWork: async (_work, result) => { waiting = result },
    }
    const model: ModelDriver = {
      run: async () => ({ text: '', output: [{ type: 'function_call', callId: 'c', name: 'ipython', arguments: '{"code":"1"}' }], usage: { available: false, inputTokens: 0, outputTokens: 0 } }),
      structured: async () => { throw new Error('unexpected') }, compact: async () => { throw new Error('unexpected') },
    }
    const kernels: KernelExecutor = { execute: async () => {
      if (mode === 'approval') throw new ApprovalPendingError('approval-id', 'cell')
      return { executionId: 'cell', stdout: '', stderr: '', result: null, durationMs: 1, truncated: false, artifacts: [], directives: [{ type: 'defer', reason: mode }] }
    } }
    await new AgentRuntime(host, model, kernels).runWork(work)
    assert.equal(completion?.status, mode === 'handoff' ? 'completed' : undefined)
    const outcome = waiting ?? completion?.goalOutcome
    assert.equal(outcome?.status, mode === 'approval' ? 'awaiting_approval' : mode === 'user' ? 'awaiting_input' : 'blocked')
    assert.equal(outcome?.verification, 'not_run')
    if (outcome?.status === 'awaiting_approval') assert.equal(outcome.approvalId, 'approval-id')
  }
})


it('discards an unexecuted model candidate when steering arrives during generation', async () => {
  const work = { id: 'w', tenantId: 't', agentId: 'a', sessionId: 's', kind: 'turn', lane: 'interactive' as const, triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'token' }
  let generated = false
  let calls = 0
  let committed = ''
  let saved: SessionRecord | undefined = {
    key: '[\"t\",\"a\",\"s\",null]', tenantId: 't', agentId: 'a', sessionId: 's', revision: 1, compactionEpoch: 0, history: [], appliedWorkIds: ['w'],
    request: { version: 1, workId: 'w', tenantId: 't', sessionId: 's', authorId: 'u', sourceRef: 'm', evidence: snapshotEvidence('w:evidence:1', []), attachments: [], originalText: 'Original', revisions: [],
      contract: createTaskContract('Original', 1, { deliverables: ['OBSOLETE_DELIVERABLE'], constraints: [], actions: [], acceptance: ['Original condition'] }) },
  }
  const host: HostPort = { ...durableProtocol(),
    claimWork: async () => null,
    heartbeat: async () => ({ ok: true, steer: generated ? [{ id: 'revision', text: 'Use the new requirement', createdAt: 'now' }] : [] }),
    loadContext: async () => ({ work, persona: { name: 'A', role: 'assistant', instructions: '' }, capabilities: [], messages: [{ ref: 'm', authorId: 'u', authorName: 'U', authorKind: 'human', body: 'Original', createdAt: 'now' }] }),
    executeAction: async (_work, action) => { assert.equal(action.action, 'task.inspect'); return { ok: true, value: { requestVersion: 2, pending: [], truncated: false } } }, emitEvent: async () => {},
    loadSession: async () => saved ? structuredClone(saved) : null, saveSession: async (_work, session) => { saved = structuredClone(session) },
    commitResult: async (_work, message) => { committed = message.body }, completeWork: async () => {}, yieldWork: async () => {},
  }
  const model: ModelDriver = {
    run: async request => {
      calls++
      if (calls === 1) {
        assert.match(JSON.stringify(request.items), /OBSOLETE_DELIVERABLE/)
        generated = true
        return { text: '', output: [{ type: 'function_call', callId: 'old', name: 'ipython', arguments: '{"code":"raise Exception()"}' }], usage: { available: false, inputTokens: 0, outputTokens: 0 } }
      }
      assert.doesNotMatch(JSON.stringify(request.items), /OBSOLETE_DELIVERABLE/)
      assert.match(JSON.stringify(request.items), /Use the new requirement/)
      assert.equal(JSON.stringify(request.items).split('Use the new requirement').length - 1, 1)
      return { text: 'Revised answer', output: [{ role: 'assistant', content: 'Revised answer' }], usage: { available: false, inputTokens: 0, outputTokens: 0 } }
    }, structured: async () => { throw new Error('unexpected') }, compact: async () => { throw new Error('unexpected') },
  }
  await new AgentRuntime(host, model, { execute: async () => { throw new Error('old code must not execute') } }).runWork(work)
  assert.equal(calls, 2)
  assert.equal(committed, 'Revised answer')
  assert.equal(saved?.request?.revisions.length, 1)
  assert.equal(saved?.request?.contract, undefined)
  const revisions = structuredClone(saved?.request?.revisions)
  await new AgentRuntime(host, model, { execute: async () => { throw new Error('old code must not execute') } }).runWork({ ...work, fence: 2 })
  assert.equal(calls, 3)
  assert.deepEqual(saved?.request?.revisions, revisions)
})

it('fails without a fabricated answer on root budget exhaustion and honors late signals', async () => {
  for (const mode of ['normal', 'steer', 'cancel', 'lease_lost'] as const) {
    const work: TurnContext['work'] = { id: 'w', tenantId: 't', agentId: 'a', sessionId: 's', kind: 'turn', lane: 'interactive', triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'token' }
    let executed = false
    let committed = false
    let calls = 0
    let saved: SessionRecord | undefined
    let completion: WorkCompletion | undefined
    const artifact = { path: 'report.txt', size: 4, mime: 'text/plain', sha256: 'a'.repeat(64) }
    const host: HostPort = { ...durableProtocol(),
      claimWork: async () => null,
      heartbeat: async () => ({ ok: !(executed && mode === 'lease_lost'), cancelRequested: executed && mode === 'cancel',
        steer: executed && mode === 'steer' ? [{ id: 'r', text: 'Changed requirement', createdAt: 'now' }] : [] }),
      loadContext: async () => ({ work, persona: { name: 'A', role: 'assistant', instructions: '' }, capabilities: [],
        messages: [{ ref: 'm', authorId: 'u', authorName: 'U', authorKind: 'human', body: 'Create the requested report', createdAt: 'now' }] }),
      executeAction: async () => { throw new Error('unexpected') }, emitEvent: async () => {},
      loadSession: async () => null, saveSession: async (_work, session) => { saved = structuredClone(session) },
      commitResult: async () => { committed = true },
      completeWork: async (_work, result) => { completion = result }, yieldWork: async () => {},
    }
    const model: ModelDriver = {
      run: async () => { calls++; return { text: '', output: [{ type: 'function_call', callId: 'c', name: 'ipython', arguments: '{"code":"1"}' }], usage: { available: false, inputTokens: 0, outputTokens: 0 } } },
      structured: async () => { throw new Error('no extra grader') }, compact: async () => { throw new Error('unexpected') },
    }
    const kernels: KernelExecutor = { execute: async () => {
      executed = true
      return { executionId: 'cell', stdout: 'private tool output', stderr: '', result: null, durationMs: 1, truncated: false, artifacts: [artifact], directives: [] }
    } }
    assert.throws(() => new AgentRuntime(host, model, kernels, { rootModelBudget: { maxModelCalls: 0 } }), /positive safe integer/)
    await new AgentRuntime(host, model, kernels, { rootModelBudget: { maxModelCalls: 1 } }).runWork(work)
    assert.equal(calls, 1)
    assert.equal(committed, false)
    assert.equal(completion?.status, mode === 'cancel' ? 'cancelled' : mode === 'lease_lost' ? undefined : 'failed')
    if (mode === 'normal') assert.match(completion?.error ?? '', /budget exhausted/)
    if (mode === 'steer') assert.equal(saved?.request?.revisions[0]?.text, 'Changed requirement')
  }
})

for (const recovery of ['none', 'step', 'cell'] as const) for (const scenario of ['short', 'long', 'denied', 'unknown'] as const) it(`preserves canonical direct tool receipts and result boundaries (${scenario}, recovery=${recovery})`, async () => {
  const work: TurnContext['work'] = { id: 'direct', tenantId: 't', agentId: 'a', sessionId: 's', kind: 'turn', lane: 'interactive', triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'token' }
  const result: HostActionResult = scenario === 'denied'
    ? { ok: false, executionState: 'rejected', code: 'forbidden', error: 'permission revoked' }
    : scenario === 'unknown' ? { ok: false, executionState: 'unknown', error: 'receipt unavailable' }
    : { ok: true, value: scenario === 'long' ? { text: '\\"😀'.repeat(5000) }
      : { result: { id: 'unique-read-value' }, state: { revision: 1, visibleHash: 'current' } },
      evidence: [{ sourceId: 'source', sourceVersion: 'v1', chunkId: 'chunk', title: 'Source', excerpt: 'private-evidence-excerpt' }] }
  let calls = 0, persisted = false, delivered = false
  const recoveredAction = { runId: work.id, cellId: 'step:canonical', callIndex: 0, action: 'data.read', args: {},
    idempotencyKey: actionKeyOf({ runId: work.id, cellId: 'step:canonical', callIndex: 0 }) }
  let executed: HostAction | undefined = recovery === 'none' ? undefined : recoveredAction
  let executions = 0, modelOutput = '', evidenceSeparated = false
  const recoveredReceipts = [{ action: recoveredAction.action, idempotencyKey: recoveredAction.idempotencyKey, result }]
  const host: HostPort = { ...durableProtocol(), claimWork: async () => null, heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ work, persona: { name: 'A', role: '', instructions: '' }, capabilities: ['data'],
      tools: [{ name: 'data__read', action: 'data.read', effect: 'read', approval: false, description: 'Read', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
      messages: [{ ref: 'm', authorId: 'u', authorName: 'U', authorKind: 'human', body: 'Read the data.', createdAt: 'now' }] }),
    executeAction: async (_work, action) => {
      if (action.action === 'task.inspect') return { ok: true, value: { requestVersion: 1, pending: [] } }
      executions++
      executed = action
      return result
    },
    loadSession: async () => recovery === 'none' ? null : {
      key: '["t","a","s",null]', tenantId: 't', agentId: 'a', sessionId: 's', appliedWorkIds: [work.id], revision: 1, compactionEpoch: 0,
      history: [{ type: 'function_call', name: 'data__read', callId: 'read', stepId: recoveredAction.cellId, arguments: '{}' }],
      request: { version: 1, workId: work.id, tenantId: 't', sessionId: 's', authorId: 'u', sourceRef: 'm', originalText: 'Read the data.',
        revisions: [], attachments: [], evidence: snapshotEvidence('request', []) },
    },
    recoverStep: async () => recovery === 'step' ? {
      output: boundedToolOutput({ stdout: '', stderr: '', result, truncated: false, artifacts: [], receipts: recoveredReceipts }), artifacts: [],
    } : null,
    recoverCell: async () => recovery === 'none' || recovery === 'step' && scenario === 'denied' ? null : recoveredReceipts,
    saveSession: async () => {}, emitEvent: async () => {},
    saveStep: async (_work, step) => {
      if (step.kind !== 'data__read' || !step.output) return
      if (scenario !== 'long') assert.deepEqual(JSON.parse(step.output).receipts[0].result, result)
      persisted = true
    }, commitResult: async () => { delivered = true }, completeWork: async () => {}, yieldWork: async () => {} }
  const usage = { available: false, inputTokens: 0, outputTokens: 0 }
  const model: ModelDriver = { compact: async () => { throw new Error('unexpected compaction') },
    structured: async () => ({ value: { missing: [] }, model: 'test', usage }), run: async request => {
      if (++calls === 1 && recovery === 'none') return { text: '', output: [{ type: 'function_call', callId: 'read', name: 'data__read', arguments: '{}' }], usage }
      const output = request.items.find(item => 'type' in item && item.type === 'function_call_output')
      assert.ok(output && 'output' in output)
      modelOutput = output.output
      evidenceSeparated = JSON.stringify(request.items).includes('Retrieved evidence follows')
      return { text: 'Read the value.', output: [{ role: 'assistant', content: 'Read the value.' }], usage }
    } }
  await new AgentRuntime(host, model, { execute: async () => { throw new Error('unexpected Python') } }).runWork(work)
  assert.deepEqual({ calls, persisted, delivered, executions }, recovery === 'none'
    ? { calls: 2, persisted: true, delivered: true, executions: 1 }
    : { calls: 1, persisted: false, delivered: true, executions: 0 })
  assert.ok(executed)
  const receipt = { action: 'data.read', idempotencyKey: actionKeyOf({ runId: work.id, cellId: executed.cellId, callIndex: 0 }),
    ...(result.ok ? { sha256: observationRef(executed.idempotencyKey, result.value).sha256 } : {}) }
  assert.notEqual(receipt.idempotencyKey, 'read', 'provider call IDs are not canonical receipt keys')
  assert.ok(modelOutput.length <= MAX_TOOL_OUTPUT_CHARS)
  assert.doesNotMatch(modelOutput, /private-evidence-excerpt|"evidence"/)
  const { evidence: _evidence, ...visibleResult } = result
  const recovered = recovery === 'none' ? {} : { recovered: true }
  if (scenario === 'long') {
    const parsed = JSON.parse(modelOutput)
    assert.deepEqual({ ...parsed, preview: undefined }, {
      truncated: true, originalCharacters: JSON.stringify(visibleResult).length,
      observations: [observationRef(receipt.idempotencyKey, result.value)], read: 'observations.read',
      preview: undefined, receipt, ...recovered,
    })
    assert.ok(JSON.stringify(visibleResult).startsWith(parsed.preview))
    assert.ok(parsed.preview.length > 0)
  } else {
    assert.deepEqual(JSON.parse(modelOutput), { ...visibleResult, receipt, ...recovered })
    if (scenario === 'short') {
      assert.equal(modelOutput.split('unique-read-value').length - 1, 1)
      assert.equal(evidenceSeparated, true)
    }
  }
})

it('preserves unknown action outcomes in public events and model receipts', async () => {
  const work: TurnContext['work'] = { id: 'w', tenantId: 't', agentId: 'a', sessionId: 's', kind: 'turn', lane: 'interactive', triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'token' }
  const result = { ok: false, executionState: 'unknown' as const, error: 'receipt unavailable' }
  let eventResult: unknown
  let calls = 0
  let completion: WorkCompletion | undefined
  const host: HostPort = { ...durableProtocol(),
    claimWork: async () => null, heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ work, persona: { name: 'A', role: 'assistant', instructions: '' }, capabilities: ['files'], messages: [{ ref: 'm', authorId: 'u', authorName: 'User', authorKind: 'human', body: 'Save the requested file.', createdAt: 'now' }] }),
    executeAction: async () => result, emitEvent: async (_work, event) => { if (event.kind === 'tool.completed') eventResult = event.data['result'] },
    loadSession: async () => null, saveSession: async () => {}, commitResult: async (_work, message) => { completion = { status: 'completed', goalOutcome: message.envelope.goalOutcome } },
    completeWork: async (_work, value) => { completion = value }, yieldWork: async () => {},
  }
  const model: ModelDriver = {
    run: async request => {
      if (++calls === 1) return { text: '', output: [{ type: 'function_call', callId: 'c', name: 'ipython', arguments: '{"code":"host.files.save()"}' }], usage: { available: false, inputTokens: 0, outputTokens: 0 } }
      const output = request.items.find(item => 'type' in item && item.type === 'function_call_output')
      assert.ok(output && 'output' in output)
      assert.deepEqual(JSON.parse(output.output).receipts[0].result, result)
      return { text: 'The save outcome is unknown.', output: [{ role: 'assistant', content: 'The save outcome is unknown.' }], usage: { available: false, inputTokens: 0, outputTokens: 0 } }
    }, structured: async () => { throw new Error('unexpected') }, compact: async () => { throw new Error('unexpected') },
  }
  const kernels: KernelExecutor = { execute: async (_work, _run, _cell, _code, _signal, options) => {
    const action = { runId: 'w', cellId: 'hop-1', callIndex: 0, action: 'files.save', args: {}, idempotencyKey: '[\"w\",\"hop-1\",0]' }
    await options?.onHostAction?.({ stage: 'started', action })
    await options?.onHostAction?.({ stage: 'completed', action, result })
    return { executionId: 'cell', stdout: '', stderr: '', result: null, durationMs: 1, truncated: false, artifacts: [], directives: [] }
  } }
  await new AgentRuntime(host, model, kernels).runWork(work)
  assert.equal(completion?.status, 'completed')
  assert.deepEqual(eventResult, { status: 'unknown', error: 'receipt unavailable', reconciliationRequired: true })
})

it('keeps approval decisions separate from execution evidence when restoring a session', async () => {
  for (const approval of [
    { approvalId: 'approval', approved: true },
    { approvalId: 'approval', approved: true, error: 'execution unavailable' },
    { approvalId: 'approval', approved: false },
    { approvalId: 'approval', approved: true, result: { executionState: 'unknown' } },
  ]) {
    const work: TurnContext['work'] = { id: 'w', tenantId: 't', agentId: 'a', sessionId: 's', kind: 'resume', lane: 'interactive', triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'token' }
    let observed = false
    const host: HostPort = { ...durableProtocol(),
      claimWork: async () => null, heartbeat: async () => ({ ok: true }),
      loadContext: async () => ({ work, persona: { name: 'A', role: 'assistant', instructions: '' }, capabilities: [], messages: [{ ref: 'm', authorId: 'u', authorName: 'User', authorKind: 'human', body: 'Save the requested file.', createdAt: 'now' }], pendingApproval: approval }),
      executeAction: async () => { throw new Error('unexpected execution') }, emitEvent: async () => {},
      loadSession: async () => null, saveSession: async () => {}, commitResult: async () => {},
      completeWork: async () => {}, yieldWork: async () => {},
    }
    const model: ModelDriver = {
      run: async request => {
        const serialized = JSON.stringify(request.items)
        assert.doesNotMatch(serialized, /approved and executed/)
        assert.match(serialized, /decision alone does not establish execution/)
        assert.match(serialized, approval.approved ? /was approved/ : /was rejected/)
        if (approval.error) assert.match(serialized, /execution unavailable/)
        if (approval.result) assert.match(serialized, /unknown/)
        observed = true
        return { text: 'Execution remains unverified.', output: [{ role: 'assistant', content: 'Execution remains unverified.' }], usage: { available: false, inputTokens: 0, outputTokens: 0 } }
      }, structured: async () => { throw new Error('unexpected') }, compact: async () => { throw new Error('unexpected') },
    }
    await new AgentRuntime(host, model, { execute: async () => { throw new Error('unexpected') } }).runWork(work)
    assert.equal(observed, true)
  }
})

it('fails before model or side effects when the original request cannot be captured', async () => {
  const work: TurnContext['work'] = { id: 'w', tenantId: 't', agentId: 'a', sessionId: 's', kind: 'turn', lane: 'interactive', triggerRef: 'missing', fence: 1, homeEpoch: 1, leaseToken: 'token' }
  const calls: string[] = []
  let completion: WorkCompletion | undefined
  const unexpected = async () => { calls.push('unexpected'); throw new Error('unexpected execution') }
  const host: HostPort = { ...durableProtocol(),
    claimWork: async () => null, heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ work, persona: { name: 'A', role: 'assistant', instructions: '' }, capabilities: ['files'], messages: [] }),
    executeAction: unexpected, emitEvent: async () => {}, loadSession: async () => null,
    saveSession: unexpected, commitResult: unexpected, yieldWork: unexpected,
    completeWork: async (_work, result) => { completion = result },
  }
  await new AgentRuntime(host, { run: unexpected, structured: unexpected, compact: unexpected }, { execute: unexpected }).runWork(work)
  assert.deepEqual(calls, [])
  assert.equal(completion?.status, 'failed')
  assert.match(completion?.error ?? '', /trigger message is required/)
  assert.equal(completion?.goalOutcome?.verification, 'inconclusive')
})

for (const effect of ['uncertain', 'read'] as const) for (const recovery of ['step', 'cell'] as const) for (const name of ['ipython', 'chat__ask']) it(`parks only valid recovered native input before later calls (${name}, ${recovery}, ${effect})`, async () => {
  const work: TurnContext['work'] = { id: 'native-wait', tenantId: 't', agentId: 'a', sessionId: 's', kind: 'turn', lane: 'interactive', triggerRef: 'm', fence: 2, homeEpoch: 1, leaseToken: 'token' }
  const result: HostActionResult = { ok: true, executionState: 'succeeded', directive: { type: 'defer', reason: 'user', data: { question: 'Which city?' } } }
  const receipts = [{ action: 'chat.ask', idempotencyKey: '["native-wait","ask",0]', result }]
  const session: SessionRecord = { key: '["t","a","s",null]', tenantId: 't', agentId: 'a', sessionId: 's', appliedWorkIds: [work.id], revision: 1, compactionEpoch: 0,
    history: [{ type: 'function_call', name, callId: 'ask', arguments: '{}' },
      { type: 'function_call', name: 'chat__write', callId: 'write', arguments: '{}' }],
    request: { version: 1, workId: work.id, tenantId: 't', sessionId: 's', authorId: 'u', sourceRef: 'm', originalText: 'Ask for my city', revisions: [], attachments: [], evidence: snapshotEvidence('wait', []) } }
  let waited: unknown, completed: unknown, modelCalls = 0, toolCalls = 0
  const host: HostPort = { ...durableProtocol(), claimWork: async () => null, heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ work, persona: { name: 'A', role: '', instructions: '' }, capabilities: ['chat'], messages: [],
      tools: [{ name: 'chat__ask', action: 'chat.ask', description: 'Ask', effect, approval: false, parameters: { type: 'object', properties: {}, additionalProperties: false } },
        { name: 'chat__write', action: 'chat.write', description: 'Write', effect: 'transaction', approval: false, parameters: { type: 'object', properties: {}, additionalProperties: false } }] }),
    loadSession: async () => session, saveSession: async () => {}, emitEvent: async () => {},
    recoverStep: async () => recovery === 'step' ? { output: boundedToolOutput({ receipts }), artifacts: [] } : null,
    recoverCell: async (_work, cell) => cell === 'ask' ? receipts : null,
    executeAction: async () => { toolCalls++; return { ok: true } }, waitWork: async (_work, outcome) => { waited = outcome },
    completeWork: async (_work, outcome) => { completed = outcome }, commitResult: async () => {}, yieldWork: async () => {} }
  const unavailable = async (): Promise<never> => { modelCalls++; throw new Error('must not call model after input wait') }
  await new AgentRuntime(host, { run: unavailable, structured: unavailable, compact: unavailable },
    { execute: async () => { throw new Error('must not rerun Python') } }).runWork(work)
  if (effect === 'read') {
    assert.equal(waited, undefined)
    assert.equal((completed as WorkCompletion)?.status, 'failed')
    assert.equal(modelCalls, 0)
    assert.equal(toolCalls, 0)
    assert.doesNotMatch(JSON.stringify(session.history), /not_started/)
    return
  }
  assert.deepEqual(waited, { status: 'awaiting_input', verification: 'not_run', requestVersion: 1, question: 'Which city?' })
  assert.equal(completed, undefined)
  assert.equal(modelCalls, 0)
  assert.equal(toolCalls, 0)
  const skipped = session.history.find(item => 'type' in item && item.type === 'function_call_output' && item.callId === 'write')
  assert.ok(skipped && 'output' in skipped)
  assert.equal(JSON.parse(skipped.output).executionState, 'not_started')
})

for (const effect of ['read', 'uncertain'] as const) for (const reason of ['user', 'child'] as const) it(`enforces terminal wait contracts without contradictory parallel outputs (${effect}, ${reason})`, async () => {
  const work: TurnContext['work'] = { id: 'wait-contract', tenantId: 't', agentId: 'a', sessionId: 's', kind: 'turn',
    lane: 'interactive', triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'lease' }
  let session: SessionRecord | undefined, completed: WorkCompletion | undefined, waited: unknown
  const executed: number[] = []
  const unexpected = async (): Promise<never> => { throw new Error('unexpected next model or kernel call') }
  const host: HostPort = { ...durableProtocol(), claimWork: async () => null, heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ work, persona: { name: 'A', role: '', instructions: '' }, capabilities: ['chat'],
      tools: [{ name: 'chat__choose', action: 'chat.choose', description: 'Choose', effect, approval: false,
        parameters: { type: 'object', properties: { index: { type: 'integer' } }, additionalProperties: false } }],
      messages: [{ ref: 'm', authorId: 'u', authorName: 'U', authorKind: 'human', body: 'Choose a city.', createdAt: 'now' }] }),
    loadSession: async () => null, saveSession: async (_work, value) => { session = value }, saveStep: async () => {},
    emitEvent: async () => {}, commitResult: unexpected, completeWork: async (_work, value) => { completed = value },
    waitWork: async (_work, value) => { waited = value }, yieldWork: async () => {},
    executeAction: async (_work, action) => {
      if (action.action === 'task.inspect') return { ok: true, value: { requestVersion: 1, pending: [], truncated: false } }
      const index = Number(action.args['index']); executed.push(index)
      if (index > 0) await new Promise(resolve => setTimeout(resolve, 5))
      return index === 0 ? { ok: true, executionState: 'succeeded', value: { cardId: 'audit-card' },
        directive: { type: 'defer', reason, data: reason === 'user' ? { question: 'Which city?' } : { taskRef: 'child' } } }
        : { ok: true, executionState: 'succeeded', value: index }
    } }
  const model: ModelDriver = { structured: unexpected, compact: unexpected, run: async () => ({ text: '',
    output: [0, 1, 2, 3].map(index => ({ type: 'function_call' as const, callId: `call-${index}`, name: 'chat__choose', arguments: JSON.stringify({ index }) })),
    usage: { available: true, inputTokens: 1, outputTokens: 1 } }) }
  await new AgentRuntime(host, model, { execute: unexpected }).runWork(work)
  const outputs = session!.history.filter((item): item is Extract<ModelItem, { type: 'function_call_output' }> => 'type' in item && item.type === 'function_call_output')
  if (effect === 'read') {
    assert.equal(waited, undefined, 'read waits cannot authorize parking')
    assert.equal(completed?.status, 'failed')
    assert.match(completed?.error ?? '', /read.*wait/i)
    assert.deepEqual(executed, [0, 1, 2, 3])
    assert.equal(outputs.length, 4)
    for (let index = 0; index < 4; index++) assert.equal(outputs.filter(output => output.callId === `call-${index}`).length, 1)
    assert.doesNotMatch(JSON.stringify(outputs), /not_started/)
    assert.match(JSON.stringify(outputs), /audit-card/)
  } else {
    assert.deepEqual(executed, [0])
    assert.equal((waited as { status: string }).status, reason === 'user' ? 'awaiting_input' : 'delegated')
    if (reason === 'user') { assert.equal(outputs.length, 4); assert.equal(outputs.filter(output => /not_started/.test(output.output)).length, 3) }
  }
})
