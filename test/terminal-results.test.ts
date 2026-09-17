import assert from 'node:assert/strict'
import { it } from 'node:test'
import { AgentRuntime } from '../src/runtime/runtime.js'
import { ModelBudgetExceededError, ModelDriverError } from '../src/errors.js'
import { snapshotEvidence } from '../src/context/evidence.js'
import { checkCandidateContent } from '../src/outcome/content-check.js'
import { createResponseEnvelope } from '../src/outcome/envelope.js'
import type { HostPort } from '../src/host/port.js'
import type { ModelDriver } from '../src/model/driver.js'
import type { AssistantMessage, RunEvent, SessionRecord, TurnContext, WorkCompletion } from '../src/protocol/types.js'
import { durableProtocol } from './protocol-fixture.js'

const usage = { available: true, inputTokens: 10, outputTokens: 10 }
const unexpected = async (): Promise<never> => { throw new Error('unexpected call') }

for (const mode of ['provider', 'budget', 'format', 'invalid_citation', 'resume', 'revised', 'review', 'declared_partial'] as const) {
  it(`terminates ${mode} with only a validated current-version answer`, async () => {
    const work: TurnContext['work'] = { id: 'w', tenantId: 't', agentId: 'a', principalId: 'u', sessionId: 's',
      kind: 'turn', lane: 'interactive', triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'secret' }
    let turns = 0, session: SessionRecord | null = null, completion: WorkCompletion | undefined
    const messages: AssistantMessage[] = [], events: RunEvent[] = []
    const envelope = createResponseEnvelope('Verified portion.', { status: 'partial', verification: 'inconclusive', requestVersion: 1,
      gaps: ['Second part remains unavailable'] }, snapshotEvidence('w:evidence:1', []))
    const host: HostPort = { ...durableProtocol(), claimWork: async () => null,
      heartbeat: async () => ({ ok: true, ...(mode === 'revised' ? { steer: [{ id: 'r', text: 'Changed task.', createdAt: 'now' }] } : {}) }),
      loadContext: async () => ({ work, persona: { name: 'A', role: '', instructions: '' }, capabilities: [],
        messages: [{ ref: 'm', authorId: 'u', authorName: 'User', authorKind: 'human', body: ['review','declared_partial'].includes(mode) ? 'Answer first and second parts.' : 'Answer both parts.', createdAt: 'now' }],
        ...(['resume','revised'].includes(mode) ? { executionSteps: [{ id: 'saved', kind: 'runtime.candidate', requestVersion: 1,
          input: {}, output: JSON.stringify(envelope), artifacts: [] }] } : {}) }),
      executeAction: async () => ({ ok: true, value: { requestVersion: 1, pending: [], truncated: false } }),
      loadSession: async () => session, saveSession: async (_work, value) => { session = structuredClone(value) },
      emitEvent: async (_work, event) => { events.push(event) },
      commitResult: async (_work, message) => { messages.push(message) },
      completeWork: async (_work, value) => { completion = value }, yieldWork: async () => {} }
    const model: ModelDriver = { compact: unexpected, structured: async () => ({ value: { missing: mode === 'review'
      ? [{ quote: 'second parts.', reason: 'The requested result remains unavailable despite the disclosed limitation.' }] : [],
      limitations: mode === 'declared_partial' ? [{ quote: 'The second part is unavailable.', reason: 'The second result remains unavailable.' }] : [] }, model: 'test', usage }),
      run: async () => {
        turns++
        if (['review','declared_partial'].includes(mode)) return { text: 'Verified portion. The second part is unavailable.', output: [{ role: 'assistant', content: 'Verified portion. The second part is unavailable.' }], usage }
        if (mode === 'resume' || mode === 'revised' || mode === 'budget' && turns > 1) throw new ModelBudgetExceededError('root work model budget exhausted')
        if (mode === 'provider' && turns > 1) throw new ModelDriverError('provider echoed a private credential', { kind: 'provider', status: 400, finishReasons: [] })
        if (mode === 'format') return { text: '', output: [], finalCandidate: '{"invalid":true}', usage }
        return { text: '', output: [], finalCandidate: JSON.stringify({ body: mode === 'invalid_citation' ? '[Forged](#cite-S99)' : 'Verified portion.',
          status: 'partial', gaps: ['Second part remains unavailable'], checks: [{ requirement: 'Answer both parts.', status: 'unknown', basis: 'Only the first part was answered.' }] }), usage }
      } }
    await new AgentRuntime(host, model, { execute: unexpected }).runWork(work)
    if (['format','invalid_citation','revised'].includes(mode)) {
      assert.equal(messages.length, 0)
      assert.equal(completion?.status, 'failed')
      assert.equal(events.filter(event => event.kind === 'run.failed').length, 1)
      assert.equal(events.filter(event => event.kind === 'model.delta').length, 0)
    } else {
      assert.equal(messages.length, 1)
      assert.equal(messages[0]!.body, ['review','declared_partial'].includes(mode) ? 'Verified portion. The second part is unavailable.' : 'Verified portion.')
      assert.equal(messages[0]!.envelope.goalOutcome.status, 'partial')
      assert.equal(messages[0]!.envelope.goalOutcome.verification, 'inconclusive')
      assert.match(JSON.stringify(messages[0]!.envelope.goalOutcome.gaps), mode === 'provider' ? /HTTP 400/ : ['review','declared_partial'].includes(mode) ? /remains unavailable/ : /budget exhausted/)
      if (mode === 'declared_partial') assert.equal(turns, 1)
      assert.doesNotMatch(JSON.stringify(messages), /private credential|候选答复仍存在/)
    }
  })
}

it('reviews the same evidence and recorded attachment reads without loading an unread full file', async () => {
  const evidence = snapshotEvidence('e', [{ marker: 'S1', sourceId: 'source', sourceVersion: 'v1', chunkId: 'c', title: 'Document', excerpt: 'The answer is 47.' }])
  let reviewed = false
  const model: ModelDriver = { run: unexpected, compact: unexpected, structured: async request => {
    const input = request.input as { evidence: unknown; attachments: Array<{ preview: string; textLength: number; truncated: boolean }>; observations: unknown }
    assert.deepEqual(input.evidence, evidence)
    assert.equal(input.attachments[0]!.preview.length,512)
    assert.equal(input.attachments[0]!.textLength,900000)
    assert.equal(input.attachments[0]!.truncated,true)
    assert.match(JSON.stringify(input.observations),/The answer is 47/)
    reviewed = true
    return { value: { missing: [] }, model: 'test', usage }
  } }
  const result = await checkCandidateContent(model, { version: 1, workId: 'w', tenantId: 't', sessionId: 's', authorId: 'u', sourceRef: 'm',
    originalText: 'Answer from the file.', revisions: [], evidence, attachments: [{ id: 'file', name: 'data.txt', size: 900000, mimeType: 'text/plain', sourceVersion: 'v1', text: 'x'.repeat(900000) }] },
  'The answer is 47.', [], 32000, new AbortController().signal, [], [], { steps: [{ kind: 'task__read_attachment', output: 'The answer is 47.' }] })
  assert.equal(reviewed,true)
  assert.deepEqual(result.missing,[])
})

it('rejects a delivery limitation that is not grounded in the candidate body', async () => {
  const model: ModelDriver = { run: unexpected, compact: unexpected, structured: async () => ({
    value: { missing: [], limitations: [{ quote: 'Unstated limitation.', reason: 'Invented missing result.' }] }, model: 'test', usage }) }
  const result = await checkCandidateContent(model, { version: 1, workId: 'w', tenantId: 't', sessionId: 's', authorId: 'u', sourceRef: 'm',
    originalText: 'Calculate 17+26.', revisions: [], attachments: [], evidence: snapshotEvidence('e', []) }, '43', [], 32000, new AbortController().signal)
  assert.equal('error' in result && result.error, 'Content check was unavailable or returned invalid findings')
  assert.deepEqual(result.limitations, [])
})
