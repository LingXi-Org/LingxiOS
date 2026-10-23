import assert from 'node:assert/strict'
import { it } from 'node:test'
import { AgentRuntime } from '../src/runtime/runtime.js'
import type { HostPort } from '../src/host/port.js'
import type { ModelDriver } from '../src/model/driver.js'
import type { AssistantMessage, RunEvent, SessionRecord, TurnContext } from '../src/protocol/types.js'
import { TASK_TOOLS, type ToolDefinition } from '../src/tools/catalog.js'
import { candidateHash } from '../src/outcome/verification.js'
import { readEvidence } from '../src/context/evidence.js'
import { durableProtocol } from './protocol-fixture.js'

// Failure inventory: docs/evidence-pagination-failure-model.md. These sources,
// provider responses and timings are synthetic; no production trace is used.
it('streams source-backed text before an artifact write without five snippet read turns', async t => {
  const claims = ['Water freezes at 0°C under standard conditions.', 'A square has four equal sides.',
    'A triangle has three sides.', 'Two halves make one whole.', 'A day has twenty-four hours.']
  const evidence = claims.map((excerpt, index) => ({ marker: `S${index + 1}`, sourceId: `source-${index}`,
    sourceVersion: 'v1', chunkId: 'excerpt', title: `Source ${index}`, excerpt: excerpt + ' Synthetic source context.'.repeat(40), truncated: true }))
  evidence.push({ marker: 'S6', sourceId: 'large', sourceVersion: 'v1', chunkId: 'large', title: 'Unneeded long source',
    excerpt: 'Additional unrelated source material. '.repeat(1600), truncated: true })
  const tools: ToolDefinition[] = ['save','read'].map(method => ({ name: `document__${method}`, action: `document.${method}`,
    description: `${method} the synthetic comparison artifact`, parameters: { type: 'object', properties: {}, additionalProperties: false },
    effect: method === 'save' ? 'idempotent' : 'read', approval: false }))
  const work: TurnContext['work'] = { id: 'evidence-first-answer', tenantId: 'tenant', agentId: 'agent', principalId: 'human', sessionId: 'room',
    kind: 'turn', lane: 'interactive', triggerRef: 'question', fence: 1, homeEpoch: 1, leaseToken: 'fixture',
    meta: { mode: 'execute', deliveryMode: 'auto', codeExecution: 'disabled' } }
  const events: RunEvent[] = [], order: string[] = []
  let session: SessionRecord | null = null, committed: AssistantMessage | undefined
  let generations = 0, reads = 0, writes = 0, verifications = 0, reviews = 0, firstAnswerMs: number | undefined
  const began = performance.now(), usage = { available: true, inputTokens: 100, outputTokens: 25 }
  const explanation = claims.map((claim, index) => `[${claim}](#cite-S${index + 1})`).join(' ')
  const host: HostPort = { ...durableProtocol(), claimWork: async () => null, heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ work, persona: { name: 'Agent', role: '', instructions: '' }, capabilities: ['document','task'], tools: [...TASK_TOOLS,...tools],
      publicTextAllowed: true, evidence, messages: [{ ref: 'question', authorId: 'human', authorName: 'Human', authorKind: 'human',
        body: 'Explain the five short sources, then save and verify a comparison artifact.', createdAt: 'now' }] }),
    executeAction: async (_work, action) => {
      if (action.action === 'task.inspect') return { ok: true, value: { requestVersion: 1, pending: [], truncated: false, completedBusinessAction: writes === 1 } }
      if (action.action === 'task.read_evidence') { reads++; return { ok: true, value: readEvidence(session!.request!.evidence, action.args) } }
      if (action.action === 'document.save') {
        assert.ok(events.some(event => event.kind === 'public.text.delta' && event.data['purpose'] === 'answer' && event.data['text'] === explanation))
        order.push('save'); writes++; return { ok: true, value: { id: 'comparison', version: 'v1', saved: true } }
      }
      assert.equal(action.action, 'document.read'); assert.equal(writes, 1)
      order.push('verify'); verifications++; return { ok: true, value: { id: 'comparison', version: 'v1', available: true } }
    },
    loadSession: async () => structuredClone(session), saveSession: async (_work, value) => { session = structuredClone(value) },
    emitEvent: async (_work, event) => { events.push(structuredClone(event)); if (event.kind === 'public.text.delta' && event.data['purpose'] === 'answer') {
      firstAnswerMs ??= performance.now() - began; order.push('answer')
    } },
    verifyCandidate: async (_work, candidate) => ({ requestVersion: candidate.requestVersion, candidateHash: candidateHash(candidate),
      records: [{ checker: 'resource', status: writes === 1 && verifications === 1 ? 'passed' : 'failed', evidence: { available: verifications === 1 } }] }),
    commitResult: async (_work, message) => { committed = message; order.push('commit') },
    completeWork: async (_work, completion) => { assert.fail(JSON.stringify(completion)) }, yieldWork: async () => {} }
  const model: ModelDriver = { previewFormat: 'user-text', publicTextProtocol: 'purpose-json-v2',
    compact: async () => { throw new Error('Unexpected compaction') },
    structured: async () => { reviews++; throw new Error('Unexpected auxiliary review') },
    run: async request => {
      generations++
      // A controlled local provider delay makes additional serial model hops
      // observable. It is not an estimate of any hosted provider's latency.
      await new Promise(resolve => setTimeout(resolve, 25))
      const input = JSON.stringify(request.items), missing = claims.findIndex(claim => !input.includes(claim))
      if (missing >= 0) return { text: '', output: [{ type: 'function_call', callId: `source-${missing}`, name: 'task__read_evidence',
        arguments: JSON.stringify({ index: missing, offset: 0, limit: 1600 }) }], usage }
      if (!writes) {
        await request.onTextDelta?.(explanation, { purpose: 'answer' })
        return { text: explanation, output: [{ role: 'assistant', content: explanation },
          { type: 'function_call', callId: 'save', name: 'document__save', arguments: '{}' }], usage }
      }
      if (!verifications) return { text: '', output: [{ type: 'function_call', callId: 'verify', name: 'document__read', arguments: '{}' }], usage }
      const text = explanation + ' The comparison artifact is saved and verified.'
      await request.onTextDelta?.(text, { purpose: 'answer' })
      return { text, output: [{ role: 'assistant', content: text }], outcomeDeclaration: { status: 'satisfied', gaps: [] }, usage }
    } }
  await new AgentRuntime(host, model, { execute: async () => { throw new Error('Unexpected kernel') } }).runWork(work)
  t.diagnostic(JSON.stringify({ synthetic: true, modelCalls: generations, evidenceReads: reads, artifactWrites: writes,
    artifactVerifications: verifications, auxiliaryReviews: reviews, firstDurableAnswerMs: firstAnswerMs, totalMs: performance.now() - began }))
  assert.equal(reads, 0, 'already-visible complete snippets require no extra model/tool turns')
  assert.equal(generations, 3, 'explanation/write, verification, final delivery')
  assert.equal(reviews, 0); assert.equal(writes, 1); assert.equal(verifications, 1)
  assert.deepEqual(order, ['answer','save','verify','answer','commit'])
  assert.equal(committed?.envelope.goalOutcome.status, 'satisfied')
  assert.equal(committed?.envelope.citations.length, 5)
})
