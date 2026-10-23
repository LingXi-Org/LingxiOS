import assert from 'node:assert/strict'
import { it } from 'node:test'
import { AgentRuntime } from '../src/runtime/runtime.js'
import { DefaultRuntimePolicy } from '../src/runtime/policy.js'
import type { HostPort } from '../src/host/port.js'
import type { ModelDriver } from '../src/model/driver.js'
import type { AssistantMessage, TurnContext, WorkCompletion } from '../src/protocol/types.js'
import { durableProtocol } from './protocol-fixture.js'

// Failure model: docs/evidence/conversation-delivery-repair/FAILURE-MODEL.md.
const original = 'Create a complete interactive comparison.'
const usage = { available: true,inputTokens: 100,outputTokens: 20 }
function fixture() {
  const work: TurnContext['work'] = { id: 'conversation-repair',tenantId: 'tenant',agentId: 'agent',sessionId: 'room',principalId: 'human',
    kind: 'turn',lane: 'interactive',triggerRef: 'request',fence: 1,homeEpoch: 1,leaseToken: 'token',
    meta: { conversationTurn: true,mode: 'execute',deliveryMode: 'auto',codeExecution: 'disabled' },
    conversation: { conversationId: 'room',policyVersion: 1,source: { messageId: 'request',version: 1 },internal: false,
      audience: { visibility: 'conversation',participantIds: ['human','agent','peer'] } } }
  let committed: AssistantMessage | undefined, completion: WorkCompletion | undefined
  const host: HostPort = { ...durableProtocol(),claimWork: async () => null,heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ work,persona: { name: 'Agent',role: '',instructions: '' },capabilities: [],
      messages: [{ ref: 'request',authorId: 'human',authorName: 'Human',authorKind: 'human',body: original,createdAt: 'now' }] }),
    executeAction: async () => ({ ok: true,value: { requestVersion: 1,pending: [],truncated: false } }),
    loadSession: async () => null,saveSession: async () => {},emitEvent: async () => {},
    commitResult: async (_work,message) => { committed = message },completeWork: async (_work,value) => { completion = value },yieldWork: async () => {} }
  return { work,host,result: () => ({ committed,completion }) }
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
  assert.equal(reviews,assessment ? 1 : 2, 'one joint review per candidate, without a serial scope call')
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
