import assert from 'node:assert/strict'
import { it } from 'node:test'
import { AgentRuntime } from '../src/runtime/runtime.js'
import { responseProfile } from '../src/runtime/response-policy.js'
import type { ExecutionStep } from '../src/control-plane/steps.js'
import type { HostPort } from '../src/host/port.js'
import type { ModelDriver } from '../src/model/driver.js'
import type { SessionRecord, WorkItem } from '../src/protocol/types.js'
import type { ModelCallObservation } from '../src/model/execution.js'
import { durableProtocol } from './protocol-fixture.js'

const work: WorkItem = { id: 'auto', tenantId: 't', agentId: 'a', principalId: 'u', sessionId: 's', kind: 'turn',
  lane: 'interactive', triggerRef: 'm', fence: 1, homeEpoch: 1, leaseToken: 'token', meta: { text: 'Explain this.' } }
const upgrade: ExecutionStep = { id: 'response:deep:1', kind: 'runtime.response', requestVersion: 1,
  input: { profile: 'deep' }, output: '{}', artifacts: [] }

it('defaults to deep and never automatically downgrades existing work or attached/delegated/background requests', () => {
  assert.equal(responseProfile(undefined, work, [], 1), 'deep')
  assert.equal(responseProfile('auto', work, [], 1), 'fast')
  for (const changed of [{ ...work, kind: 'routine' }, { ...work, lane: 'background' as const },
    { ...work, meta: { attachments: [{ id: 'file' }] } }, { ...work, meta: { delegation: {} } }]) {
    assert.equal(responseProfile('auto', changed, [], 1), 'deep')
  }
  assert.equal(responseProfile('auto', work, [upgrade], 1), 'deep')
  assert.equal(responseProfile('auto', { ...work, fence: 2 }, [upgrade], 1), 'deep')
  assert.equal(responseProfile('auto', work, [upgrade], 2), 'fast')
})

for (const escalate of [false, true]) it(`routes without a classifier and preserves the shared ledger (escalate=${escalate})`, async () => {
  const steps: ExecutionStep[] = [], observations: ModelCallObservation[] = []
  let session: SessionRecord | null = null, body = '', fastCalls = 0, deepCalls = 0
  const protocol = durableProtocol(value => observations.push(value))
  const host: HostPort = { ...protocol, claimWork: async () => null, heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ work, responseProfile: responseProfile('auto', work, steps, 1),
      executionSteps: steps, persona: { name: 'A', role: '', instructions: '' }, capabilities: [], tools: [],
      evidence: steps.some(step => step.kind === 'runtime.response') ? [{ marker: 'S1', sourceId: 'source', sourceVersion: '1',
        chunkId: 'chunk', title: 'Authorized source', excerpt: 'Verified fact.' }] : [],
      messages: [{ ref: 'm', authorId: 'u', authorName: 'U', authorKind: 'human', body: 'Explain this.', createdAt: '' }] }),
    loadSession: async () => session, saveSession: async (_work, value) => { session = structuredClone(value) },
    saveStep: async (_work, step) => { steps.push(step) },
    executeAction: async () => ({ ok: true, value: { requestVersion: 1, pending: [], truncated: false } }),
    emitEvent: async () => {}, commitResult: async (_work, message) => { body = message.body },
    completeWork: async () => {}, yieldWork: async () => {} }
  const usage = { available: true, inputTokens: 20, outputTokens: 10 }
  const unexpected = async () => { throw new Error('unexpected auxiliary model call') }
  const deep: ModelDriver = { modelId: 'deep', configurationFingerprint: 'deep-config', compact: unexpected,
    structured: async () => ({ model: 'deep', usage, value: { missing: [] } }), run: async request => {
      deepCalls++
      assert.ok(steps.some(step => step.kind === 'runtime.response'))
      assert.ok(!request.items.some(item => 'type' in item && item.type === 'function_call_output'),
        'a response upgrade must not look like an external action')
      assert.ok(request.items.some(item => 'content' in item && String(item.content).includes('Verified fact.')))
      return { text: 'Deep answer.', output: [{ role: 'assistant', content: 'Deep answer.' }], usage }
    } }
  const fast: ModelDriver = { ...deep, modelId: 'fast', configurationFingerprint: 'fast-config', run: async request => {
    fastCalls++
    assert.equal(request.codeExecution, 'disabled')
    assert.deepEqual(request.tools?.map(tool => tool.name), ['response__upgrade'])
    request.onTextDelta?.('Direct answer.')
    return escalate ? { text: '', output: [{ type: 'function_call', name: 'response__upgrade', callId: 'upgrade', arguments: '{}' }], usage }
      : { text: 'Direct answer.', output: [{ role: 'assistant', content: 'Direct answer.' }], usage }
  } }
  await new AgentRuntime(host, deep, { execute: unexpected }, { fastModel: fast }).runWork(work)
  assert.equal(body, escalate ? 'Deep answer.' : 'Direct answer.')
  assert.equal(fastCalls, 1)
  assert.equal(deepCalls, escalate ? 1 : 0)
  assert.equal(observations.filter(call => call.purpose === 'agent-turn').length, escalate ? 2 : 1)
  assert.equal(new Set(observations.map(call => call.callId)).size, observations.length)
  assert.equal(observations[0]?.configurationFingerprint, 'fast-config')
  assert.equal(typeof observations[0]?.firstContentMs, 'number')
})
