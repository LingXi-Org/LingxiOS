import { MemoryModelBudgetStore } from '../src/control-plane/memory-store.js'
import { durableProtocol } from './protocol-fixture.js'
import { MemoryStepStore } from '../src/control-plane/steps.js'
import { appendReadEvidence, appendResearchEvidence } from '../src/context/research-evidence.js'
import { createTaskContract } from '../src/context/task-contract.js'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { snapshotEvidence, evidenceItems } from '../src/context/evidence.js'
import { createResponseEnvelope, snapshotArtifacts } from '../src/outcome/envelope.js'
import { responseSegments } from '../src/ui/index.js'
import { ControlPlaneService } from '../src/control-plane/service.js'
import { MemoryActionLedger, MemoryEventStore, MemorySessionStore, MemoryWorkStore } from '../src/control-plane/memory-store.js'
import { AgentRuntime } from '../src/runtime/runtime.js'
import type { HostPort } from '../src/host/port.js'
import { sessionKeyOf, type AssistantMessage } from '../src/protocol/types.js'
import type { ModelDriver } from '../src/model/driver.js'
import { snapshotRequest } from '../src/context/request.js'
import type { SessionRecord } from '../src/protocol/types.js'
import { DefaultRuntimePolicy } from '../src/runtime/policy.js'
import type { TurnContext } from '../src/protocol/types.js'

it('keeps read evidence identities stable across JSONB key ordering and multiple reads', () => {
  const first = { sourceId: 'attachment:a',sourceVersion: 'v1',title: 'A',chunkId: 'a:0:8',excerpt: 'Value: 7',truncated: true }
  const second = { ...first,sourceId: 'attachment:b',title: 'B',chunkId: 'b:0:8',excerpt: 'Value: 9' }
  const reorder = <T>(value: T): T => JSON.parse(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).reverse()) : item)) as T
  const initial = snapshotEvidence('initial',[])
  const expected = appendReadEvidence(appendReadEvidence(initial,'a',{ ok: true,evidence: [first] },'task.read_attachment'),
    'b',{ ok: true,evidence: [second] },'task.read_attachment')
  const persisted = appendReadEvidence(reorder(appendReadEvidence(initial,'a',{ ok: true,evidence: [reorder(first)] },'task.read_attachment')),
    'b',{ ok: true,evidence: [reorder(second)] },'task.read_attachment')
  assert.deepEqual(persisted,expected)
})

it('records attachment range citations and reauthorizes snapshots before reads, actions and delivery', async () => {
  let revoked = false
  const service = new ControlPlaneService({ modelBudgets: new MemoryModelBudgetStore(),steps: new MemoryStepStore(),work: new MemoryWorkStore(),
    sessions: new MemorySessionStore(),events: new MemoryEventStore(),actions: new MemoryActionLedger(),
    contextProvider: { authorizeRequest: async (_work, request) => {
      assert.equal(request.attachments[0]!.id,'file')
      if (revoked) throw new Error('source permission revoked')
    }, loadContext: async () => ({ persona: { name: 'A',role: '',instructions: '' },capabilities: [],
      messages: [{ ref: 'm',authorId: 'u',authorName: 'U',authorKind: 'human',body: 'Read file',createdAt: 'now' }] }) },
    capabilityResolver: { resolve: async () => [] },actionExecutor: { prepare: async () => {},execute: async () => { throw new Error('unexpected') } },
    delivery: { onEvent: async () => {},deliverMessage: async () => {} } })
  await service.enqueue({ id: 'attachment',tenantId: 't',agentId: 'a',sessionId: 's',principalId: 'u',kind: 'turn',lane: 'interactive',triggerRef: 'm',
    meta: { text: 'Read file',attachments: [{ id: 'file',sourceVersion: 'v1',name: 'facts.txt',mimeType: 'text/plain',size: 18,text: 'Before. Value: 47.' }] } })
  const work = (await service.claim('worker'))!, key = sessionKeyOf(work)
  const session: SessionRecord = { key,tenantId: 't',agentId: 'a',sessionId: 's',history: [],appliedWorkIds: [work.id],revision: 0,compactionEpoch: 0,
    request: snapshotRequest(await service.loadContext(work)) }
  session.revision = (await service.saveSession(work,session)).revision
  const action = { runId: work.id,cellId: 'read',callIndex: 0,idempotencyKey: JSON.stringify([work.id,'read',0]),action: 'task.read_attachment',
    args: { id: 'file',sourceVersion: 'v1',offset: 8,limit: 16000 } }
  const receipt = await service.executeAction(work,action)
  assert.deepEqual(receipt.evidence,[{ sourceId: 'attachment:file',sourceVersion: 'v1',title: 'facts.txt',chunkId: 'file:8:18',excerpt: 'Value: 47.',truncated: true }])
  session.request!.evidence = appendReadEvidence(session.request!.evidence,action.idempotencyKey,receipt,action.action)
  session.revision = (await service.saveSession(work,session)).revision
  const body = '[Value: 47](#cite-S1)', envelope = createResponseEnvelope(body,{ status: 'partial',verification: 'inconclusive',requestVersion: 1 },session.request!.evidence)
  revoked = true
  await assert.rejects(service.getSession(work,key),/source permission revoked/)
  await assert.rejects(service.loadContext(work),/source permission revoked/)
  await assert.rejects(service.executeAction(work,action),/source permission revoked/)
  await assert.rejects(service.commitResult(work,{ version: 2,runId: work.id,agentId: 'a',sessionId: 's',body,envelope }),/source permission revoked/)
})

it('delivers the latest recorded version of each artifact path', () => {
  const first = { path: 'report.txt', size: 3, mime: 'text/plain', sha256: 'a'.repeat(64) }
  const latest = { ...first, size: 4, sha256: 'b'.repeat(64) }
  const other = { ...first, path: 'notes.txt' }
  const inventory = snapshotArtifacts([first, other, latest, latest])
  assert.deepEqual(inventory, [latest, other])
  latest.size = 100
  assert.equal(inventory[0]!.size, 4)
  assert.throws(() => snapshotArtifacts([first, { ...first, sha256: 'invalid' }]), /invalid response artifacts/)
  for (const path of ['/outside', '../outside', 'folder/../outside', 'C:/outside', 'folder\\outside', 'folder//file', './report', 'bad\u0000name']) {
    assert.throws(() => snapshotArtifacts([{ ...first, path }]), /invalid response artifacts/)
  }
  assert.deepEqual(snapshotArtifacts([{ ...first, path: '报告/章节 1.txt' }]), [{ ...first, path: '报告/章节 1.txt' }])
})

it('restores prior artifact records for current verification and keeps uncertainty visible', async () => {
  let now = Date.now()
  const workStore = new MemoryWorkStore({}, () => now)
  const steps = new MemoryStepStore()
  const messages: AssistantMessage[] = []
  const service = new ControlPlaneService({ modelBudgets: new MemoryModelBudgetStore(), steps, work: workStore, sessions: new MemorySessionStore(), events: new MemoryEventStore(), actions: new MemoryActionLedger(),
    contextProvider: { loadContext: async () => ({ persona: { name: 'A', role: 'assistant', instructions: '' }, capabilities: [],
      messages: [{ ref: 'm', authorId: 'u', authorName: 'U', authorKind: 'human', body: 'Deliver the report', createdAt: 'now' }] }) },
    capabilityResolver: { resolve: async () => [] }, actionExecutor: { prepare: async () => {}, execute: async () => ({ ok: false }) },
    delivery: { onEvent: async () => {}, deliverMessage: async (_work, message) => { messages.push(message) } } })
  await service.enqueue({ id: 'artifacts', tenantId: 't', agentId: 'a', sessionId: 's', principalId: 'u', kind: 'turn', lane: 'interactive', triggerRef: 'm', meta: { text: 'Deliver the report' } })
  const first = (await service.claim('worker'))!
  const artifact = { path: 'report.txt', size: 4, mime: 'text/plain', sha256: 'a'.repeat(64) }
  await assert.rejects(service.recordEvent(first, { runId: first.id, seq: 1, kind: 'ipython.completed', stage: 'completed', visibility: 'internal',
    data: { artifacts: [{ ...artifact, path: '../outside' }] } }), /invalid kernel artifact event/)
  await service.recordEvent(first, { runId: first.id, seq: 1, kind: 'ipython.completed', stage: 'completed', visibility: 'internal',
    data: { callId: 'prior-cell', requestVersion: 1, output: 'prior output', artifacts: [artifact] } })
  await steps.save({ workId: first.id, fence: first.fence, leaseTokenHash: 'test' }, { id: 'prior-cell', kind: 'ipython', requestVersion: 1, input: { code: 'create()' }, output: 'prior output', artifacts: [artifact] })
  assert.deepEqual((await service.loadContext(first)).priorArtifacts, [])
  await workStore.requestPreempt(first.id)
  await service.yieldWork(first)
  now += 2000
  const resumed = (await service.claim('worker'))!
  assert.ok(resumed.fence > first.fence)
  assert.deepEqual((await service.loadContext(resumed)).priorArtifacts, [artifact])
  await assert.rejects(service.loadContext(first), /lease lost/)
  const host: HostPort = { ...durableProtocol(),
    claimWork: async () => null, heartbeat: work => service.heartbeat(work), loadContext: work => service.loadContext(work),
    executeAction: (work, action) => service.executeAction(work, action), emitEvent: (work, event) => service.recordEvent(work, event),
    loadSession: (work, key) => service.getSession(work, key), saveSession: async (work, session) => { session.revision = (await service.saveSession(work, session)).revision },
    commitResult: (work, message) => service.commitResult(work, message), completeWork: (work, completion) => service.complete(work, completion), yieldWork: work => service.yieldWork(work),
  }
  const model: ModelDriver = {
    run: async request => {
      assert.match(JSON.stringify(request.items), /report.txt/)
      assert.match(JSON.stringify(request.items), /not current delivery or proof of file availability/)
      const text = 'The previous report still needs file verification.'
      return { text, output: [{ role: 'assistant', content: text }], usage: { available: false, inputTokens: 0, outputTokens: 0 } }
    }, structured: async () => { throw new Error('unexpected') }, compact: async () => { throw new Error('unexpected') },
  }
  await new AgentRuntime(host, model, { execute: async () => { throw new Error('unexpected') } }).runWork(resumed)
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0]!.envelope!.artifacts, [artifact])
  assert.equal(messages[0]!.envelope.goalOutcome.status, 'partial')
  assert.equal(messages[0]!.envelope.goalOutcome.verification, 'inconclusive')
})

it('freezes source versions, allows prose around citations and does not invent semantic support', () => {
  const items = [{ marker: 'S1', sourceId: 'source', sourceVersion: 'v1', chunkId: 'chunk', title: 'Title', excerpt: 'Only the first claim is supported.' }]
  const snapshot = snapshotEvidence('evidence-1', items)
  items[0]!.excerpt = 'Changed later'
  assert.equal(snapshot.items[0]!.excerpt, 'Only the first claim is supported.')
  const envelope = createResponseEnvelope('Explanation. [First claim](#cite-S1) Further discussion.',
    { status: 'partial', verification: 'not_run', requestVersion: 1 }, snapshot)
  assert.equal(envelope.citations[0]?.support, 'not_assessed')
  assert.deepEqual(envelope.citations[0]?.sources, [{ sourceId: 'source', sourceVersion: 'v1', chunkIds: ['chunk'] }])
  assert.deepEqual(responseSegments(envelope).map((part) => [part.type, 'text' in part ? part.text : undefined]), [
    ['text', 'Explanation. '], ['citation', 'First claim'], ['text', ' Further discussion.'],
  ])
  assert.throws(() => createResponseEnvelope('[Unknown](#cite-S2)', envelope.goalOutcome, snapshot), /unknown citation/)
  assert.throws(() => createResponseEnvelope('[Broken](#cite-S0)', envelope.goalOutcome, snapshot), /malformed/)
  assert.throws(() => snapshotEvidence('e', [items[0]!, { ...items[0]!, sourceVersion: 'v2', chunkId: 'other' }]), /conflicting/)
})

it('uses the original evidence across hops and rejects a tampered final envelope', async (t) => {
  const sessions = new MemorySessionStore()
  const messages: AssistantMessage[] = []
  let contextLoads = 0
  const service = new ControlPlaneService({ modelBudgets: new MemoryModelBudgetStore(), steps: new MemoryStepStore(),
    work: new MemoryWorkStore(), sessions, events: new MemoryEventStore(), actions: new MemoryActionLedger(),
    contextProvider: { loadContext: async () => {
      contextLoads++
      return {
        persona: { name: 'A', role: 'assistant', instructions: '' }, capabilities: [],
        messages: [{ ref: 'm', authorId: 'u', authorName: 'U', authorKind: 'human', body: 'Explain with sources.', createdAt: 'now' }],
        evidence: [{ marker: contextLoads === 1 ? 'S1' : 'S2', sourceId: 'source', sourceVersion: contextLoads === 1 ? 'v1' : 'v2', chunkId: 'chunk', title: 'Title', excerpt: contextLoads === 1 ? 'ORIGINAL_EVIDENCE' : 'REPLACED_EVIDENCE' }],
      }
    } },
    capabilityResolver: { resolve: async () => [] }, actionExecutor: { prepare: async () => {}, execute: async () => ({ ok: false }) },
    delivery: { onEvent: async () => {}, deliverMessage: async (_work, message) => { messages.push(message) } },
  })
  await service.enqueue({ id: 'w', tenantId: 't', agentId: 'a', principalId: 'u', sessionId: 's', threadId: '', kind: 'turn', lane: 'interactive', triggerRef: 'm', meta: { text: 'Explain with sources.' } })
  const work = (await service.claim('worker'))!
  const host: HostPort = { ...durableProtocol(),
    claimWork: async () => null, heartbeat: (item) => service.heartbeat(item), loadContext: (item) => service.loadContext(item),
    executeAction: (item, action) => service.executeAction(item, action), emitEvent: (item, event) => service.recordEvent(item, event),
    loadSession: (item, key) => service.getSession(item, key), saveSession: async (item, session) => { session.revision = (await service.saveSession(item, session)).revision },
    commitResult: (item, message) => service.commitResult(item, message), completeWork: async () => {}, yieldWork: async () => {},
  }
  let calls = 0
  const model: ModelDriver = {
    run: async (request) => {
      calls++
      assert.match(JSON.stringify(request.items), /ORIGINAL_EVIDENCE/)
      assert.doesNotMatch(JSON.stringify(request.items), /REPLACED_EVIDENCE/)
      const text = calls === 1 ? '[Claim](#cite-S2)' : 'Explanation. [Claim](#cite-S1) More context.'
      return { text, output: [{ role: 'assistant', content: text }], usage: { available: false, inputTokens: 0, outputTokens: 0 } }
    }, structured: async () => { throw new Error('unexpected') }, compact: async () => { throw new Error('unexpected') },
  }
  class EvidencePolicy extends DefaultRuntimePolicy {
    override validateAssistantText(_text: string, context: TurnContext) {
      assert.equal(context.evidence?.[0]?.excerpt, 'ORIGINAL_EVIDENCE')
      return null
    }
  }
  await new AgentRuntime(host, model, { execute: async () => { throw new Error('unexpected') } }, { policy: new EvidencePolicy() }).runWork(work)
  assert.equal(calls, 2)
  assert.equal(messages.length, 1)
  await assert.rejects(service.commitResult(work, { ...messages[0]!, threadId: 'another-thread' }), /stream identity/)
  assert.equal(messages.length, 1)
  assert.equal(messages[0]!.envelope?.citations[0]?.sources[0]?.sourceVersion, 'v1')
  const unverified = structuredClone(messages[0]!)
  unverified.envelope!.goalOutcome = { status: 'satisfied', verification: 'passed', requestVersion: 1 }
  await assert.rejects(service.commitResult(work, unverified), /authoritative acceptance evidence/)
  assert.equal(messages.length, 1)
  assert.equal(messages[0]!.threadId, '')
  const tampered = structuredClone(messages[0]!)
  tampered.envelope!.citations[0]!.sources[0]!.sourceVersion = 'forged'
  await assert.rejects(service.commitResult(work, tampered), /inconsistent/)
  assert.equal(messages[0]!.envelope.citationEvidence?.[0]?.excerpt, 'ORIGINAL_EVIDENCE')
  const forgedExcerpt = structuredClone(messages[0]!)
  forgedExcerpt.envelope.citationEvidence![0]!.excerpt = 'Invented source paragraph'
  await assert.rejects(service.commitResult(work, forgedExcerpt), /inconsistent/)
  const omittedExcerpt = structuredClone(messages[0]!)
  delete omittedExcerpt.envelope.citationEvidence
  await assert.rejects(service.commitResult(work, omittedExcerpt), /inconsistent/)
  const { envelope: _envelope, ...withoutEnvelope } = messages[0]!
  await assert.rejects(service.commitResult(work, withoutEnvelope as AssistantMessage), /envelope is required/)
  await assert.rejects(service.commitResult(work, { ...messages[0]!, data: { goalOutcome: messages[0]!.envelope.goalOutcome } } as AssistantMessage), /stream identity/)
  assert.equal(messages.length, 1)
  const session = (await sessions.get(sessionKeyOf(work)))!
  assert.deepEqual(await service.getSession(work, session.key), session)
  await assert.rejects(service.getSession(work, 'other:a:s:-'), /outside/)
  await assert.rejects(service.getSession({ ...work, leaseToken: 'invalid' }, session.key), /lease lost/)
  await assert.rejects(service.saveSession(work, { ...session, tenantId: 'other' }), /invalid session/)
  await assert.rejects(service.saveSession(work, { ...session, threadId: 'other' }), /invalid session/)
  session.request!.originalText = 'rewritten request'
  await assert.rejects(service.saveSession(work, session), /invalid session record/)
  const contracted = (await service.getSession(work, session.key))!
  const contract = createTaskContract(contracted.request!.originalText, 1, { deliverables: ['Explain with sources'], constraints: [], actions: [], acceptance: ['Supported explanation'] })
  contracted.request!.contract = contract
  await service.saveSession(work, contracted)
  await assert.rejects(service.commitResult(work, messages[0]!), /inconsistent|evidence or artifact records/)
  const withContract = structuredClone(messages[0]!)
  withContract.envelope!.taskContract = contract
  const replacedContract = structuredClone(withContract)
  replacedContract.envelope!.taskContract!.deliverables = ['Different deliverable']
  await assert.rejects(service.commitResult(work, replacedContract), /inconsistent|evidence or artifact records/)
  assert.equal(messages.length, 1)
  const savedSession = (await sessions.get(sessionKeyOf(work)))!
  const missingSnapshot = t.mock.method(sessions, 'get', async () => null)
  await assert.rejects(service.commitResult(work, withContract), /saved request and evidence snapshot/)
  const { evidence: _evidence, ...requestWithoutEvidence } = savedSession.request!
  missingSnapshot.mock.mockImplementation(async () => ({ ...savedSession, request: requestWithoutEvidence as NonNullable<typeof savedSession.request> }))
  await assert.rejects(service.commitResult(work, withContract), /saved request and evidence snapshot/)
  missingSnapshot.mock.restore()
  await service.addSteer(work.id, 'Updated requirement before delivery')
  await assert.rejects(service.commitResult(work, withContract), /version is stale/)
  assert.equal(messages.length, 1)
})

it('freezes only cited chunks once, including multiple sources and repeated markers', () => {
  const items = [
    { marker: 'S1', sourceId: 'a', sourceVersion: 'v1', chunkId: 'a:1', title: 'Source A', excerpt: 'First paragraph.', actionKey: 'internal-read' },
    { marker: 'S1', sourceId: 'a', sourceVersion: 'v1', chunkId: 'a:2', title: 'Source A', excerpt: 'Second paragraph.', truncated: true },
    { marker: 'S2', sourceId: 'b', sourceVersion: 'v2', chunkId: 'b:1', title: 'Source B', excerpt: 'Other finding.', url: 'https://example.com/b' },
    { marker: 'S3', sourceId: 'c', sourceVersion: 'v3', chunkId: 'c:1', title: 'Not cited', excerpt: 'PRIVATE UNUSED MATERIAL' },
  ]
  const snapshot = snapshotEvidence('e', items)
  const body = 'Intro. [**First** finding](#cite-S1,S1) and [combined finding](#cite-S1,S2).'
  const envelope = createResponseEnvelope(body, { status: 'partial', verification: 'not_run', requestVersion: 1 }, snapshot)
  const expected = items.slice(0, 3).map(({ actionKey: _actionKey, ...item }) => item)
  assert.deepEqual(envelope.citationEvidence, expected)
  snapshot.items[0]!.excerpt = 'Changed after committing'
  assert.deepEqual(envelope.citationEvidence, expected)
  assert.equal(responseSegments(envelope).filter(segment => segment.type === 'citation').length, 2)
  assert.doesNotMatch(JSON.stringify(envelope), /internal-read|PRIVATE UNUSED MATERIAL/)
  const historical = { ...envelope }; delete historical.citationEvidence
  assert.deepEqual(responseSegments(historical), responseSegments(envelope))
  const missing = structuredClone(envelope); missing.citationEvidence!.pop()
  assert.throws(() => responseSegments(missing), /unknown citation marker/)
  const wrong = structuredClone(envelope); wrong.citationEvidence![0]!.sourceVersion = 'wrong'
  assert.throws(() => responseSegments(wrong), /conflicting|recorded sources/)
  const unused = structuredClone(envelope); unused.citationEvidence!.push(items[3]!)
  assert.throws(() => responseSegments(unused), /unreferenced citation evidence/)
})

it('bounds cited JSON by UTF-8 bytes without silently truncating source text', () => {
  const source = { marker: 'S1', sourceId: 'a', sourceVersion: 'v1', chunkId: 'c', title: 'Title', excerpt: '界'.repeat(60_000) }
  const outcome = { status: 'partial' as const, verification: 'not_run' as const, requestVersion: 1 }
  const evidence = snapshotEvidence('e', [source, { ...source, marker: 'S2', sourceId: 'b' }])
  const one = createResponseEnvelope('[Finding](#cite-S1)', outcome, evidence)
  assert.equal(one.citationEvidence![0]!.excerpt, source.excerpt)
  assert.throws(() => createResponseEnvelope('[Findings](#cite-S1,S2)', outcome, evidence), /256 KiB.*narrower source ranges/)
  assert.deepEqual(createResponseEnvelope('No citation', outcome, evidence).citationEvidence, [])
})

for (const actionName of ['research.read', 'knowledge.read_source']) it(`promotes recorded ${actionName} text and rejects forged evidence`, async () => {
  const messages: AssistantMessage[] = []
  let completion: unknown
  const source = { text: 'Observed research finding.', finalUrl: 'https://example.com/paper', sha256: 'a'.repeat(64) }
  const result = { ok: true, value: source, ...(actionName === 'knowledge.read_source' ? { evidence: [{
    sourceId: source.finalUrl, sourceVersion: `sha256:${source.sha256}`, chunkId: 'page:0', title: 'Paper', excerpt: source.text, truncated: true,
  }] } : {}) }
  const [namespace, method] = actionName.split('.')
  const service = new ControlPlaneService({ modelBudgets: new MemoryModelBudgetStore(), steps: new MemoryStepStore(), work: new MemoryWorkStore(), sessions: new MemorySessionStore(), events: new MemoryEventStore(), actions: new MemoryActionLedger(),
    contextProvider: { loadContext: async () => ({ persona: { name: 'A', role: 'assistant', instructions: '' }, capabilities: ['research'],
      messages: [{ ref: 'm', authorId: 'u', authorName: 'U', authorKind: 'human', body: 'Read the paper and cite its finding.', createdAt: 'now' }] }) },
    tools: [{ name: actionName.replace('.', '__'), action: actionName, effect: 'read', approval: false, semanticVersion: '1', description: 'Read source',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, additionalProperties: false } }],
    capabilityResolver: { resolve: async () => [{ name: namespace!, methods: [method!] }] }, actionExecutor: { prepare: async () => {}, execute: async () => result },
    delivery: { onEvent: async () => {}, deliverMessage: async (_work, message) => { messages.push(message) } } })
  await service.enqueue({ id: 'research', tenantId: 't', agentId: 'a', sessionId: 's', principalId: 'u', kind: 'turn', lane: 'interactive', triggerRef: 'm', meta: { text: 'Read the paper and cite its finding.' } })
  const work = (await service.claim('worker'))!
  const host: HostPort = { ...durableProtocol(),
    claimWork: async () => null, heartbeat: work => service.heartbeat(work), loadContext: work => service.loadContext(work),
    executeAction: (work, action) => service.executeAction(work, action), emitEvent: (work, event) => service.recordEvent(work, event),
    loadSession: (work, key) => service.getSession(work, key), saveSession: async (work, session) => { session.revision = (await service.saveSession(work, session)).revision },
    commitResult: (work, message) => service.commitResult(work, message), completeWork: (work, result) => { completion = result; return service.complete(work, result) }, yieldWork: work => service.yieldWork(work),
  }
  let calls = 0
  const model: ModelDriver = {
    run: async request => {
      calls++
      if (calls === 1) return { text: '', output: [{ type: 'function_call', callId: 'read', name: 'ipython', arguments: JSON.stringify({ code: 'host.research.read(url="https://example.com/paper")' }) }], usage: { available: false, inputTokens: 0, outputTokens: 0 } }
      assert.match(JSON.stringify(request.items), /Observed research finding/)
      assert.match(JSON.stringify(request.items), /S1/)
      const saved = (await service.getSession(work, '["t","a","s",null]'))!
      const altered = structuredClone(saved)
      altered.request!.evidence!.items[0]!.excerpt = 'Invented replacement'
      await assert.rejects(service.saveSession(work, altered), /evidence cannot be rewritten/)
      const forged = structuredClone(saved)
      forged.request!.evidence = appendReadEvidence(saved.request!.evidence!, 'missing', { ...result,
        value: { ...source, sha256: 'c'.repeat(64) }, ...(result.evidence ? { evidence: result.evidence.map(item => ({ ...item, sourceVersion: 'forged' })) } : {}) }, actionName)
      await assert.rejects(service.saveSession(work, forged), /current authorized read intent/)
      const other = { runId: work.id, cellId: 'other', callIndex: 0, idempotencyKey: JSON.stringify([work.id, 'other', 0]), action: actionName, args: { url: source.finalUrl } }
      const receipt = await service.executeAction(work, other)
      const invented = structuredClone(saved)
      invented.request!.evidence = appendReadEvidence(saved.request!.evidence!, other.idempotencyKey, { ...receipt, value: { ...source, sha256: 'b'.repeat(64) },
        ...(receipt.evidence ? { evidence: receipt.evidence.map(item => ({ ...item, sourceVersion: 'invented' })) } : {}) }, actionName)
      invented.request!.evidence.items.at(-1)!.excerpt = 'Invented addition'
      await assert.rejects(service.saveSession(work, invented), /does not match recorded/)
      const text = '[Observed research finding](#cite-S1).'
      return { text, output: [{ role: 'assistant', content: text }], usage: { available: false, inputTokens: 0, outputTokens: 0 } }
    }, structured: async () => { throw new Error('unexpected') }, compact: async () => { throw new Error('unexpected') },
  }
  await new AgentRuntime(host, model, { execute: async (_work, _run, _cell, _code, _signal, options) => {
    const action = { runId: work.id, cellId: 'read', callIndex: 0, idempotencyKey: JSON.stringify([work.id, 'read', 0]), action: actionName, args: { url: source.finalUrl } }
    await options?.onHostAction?.({ stage: 'started', action })
    const result = await service.executeAction(work, action)
    await options?.onHostAction?.({ stage: 'completed', action, result })
    return { executionId: 'read', stdout: '', stderr: '', result: null, durationMs: 1, truncated: false, artifacts: [], directives: [] }
  } }).runWork(work)
  assert.equal(calls, 2)
  assert.equal(messages.length, 1, JSON.stringify(completion))
  assert.deepEqual(messages[0]!.envelope!.citations[0]!.sources, [{ sourceId: source.finalUrl, sourceVersion: `sha256:${source.sha256}`,
    chunkIds: [actionName === 'research.read' ? JSON.stringify([work.id, 'read', 0]) : 'page:0'], ...(result.evidence ? { truncated: true } : {}) }])
  assert.equal(messages[0]!.envelope!.citations[0]!.support, 'not_assessed')
})

it('keeps citation markers stable on repeated reads and preserves earlier source versions', () => {
  const initial = snapshotEvidence('initial', [])
  const firstResult = { ok: true, value: { text: 'First version', finalUrl: 'https://example.com/source', sha256: 'a'.repeat(64) } }
  const first = appendResearchEvidence(initial, 'read-1', firstResult)
  assert.equal(appendResearchEvidence(first, 'read-1', firstResult), first)
  assert.equal(appendResearchEvidence(first, 'read-2', firstResult), first)
  const next = appendResearchEvidence(first, 'read-3', { ok: true, value: { ...firstResult.value, sha256: 'b'.repeat(64), text: 'Revised version' } })
  assert.deepEqual(next.items.map(item => [item.marker, item.excerpt, item.sourceVersion]), [
    ['S1', 'First version', `sha256:${'a'.repeat(64)}`], ['S2', 'Revised version', `sha256:${'b'.repeat(64)}`],
  ])
  assert.deepEqual(first.items, next.items.slice(0, 1))
  firstResult.value.text = 'Caller mutation'
  assert.equal(first.items[0]!.excerpt, 'First version')
  assert.equal(appendResearchEvidence(next, 'failed', { ok: false, executionState: 'unknown' }), next)
  const envelope = createResponseEnvelope('[Earlier](#cite-S1) [Later](#cite-S2)', { status: 'partial', verification: 'not_run', requestVersion: 1 }, next)
  assert.deepEqual(envelope.citations.map(citation => citation.sources[0]!.sourceVersion), [`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`])
})

it('preserves truncation limits when promoting a research excerpt', () => {
  const result = { ok: true, value: { text: 'Only the beginning.', finalUrl: 'https://example.com/long', sha256: 'a'.repeat(64), truncated: true } }
  const snapshot = appendResearchEvidence(snapshotEvidence('initial', []), 'read', result)
  assert.equal(snapshot.items[0]!.truncated, true)
  const envelope = createResponseEnvelope('[Excerpt](#cite-S1)', { status: 'partial', verification: 'not_run', requestVersion: 1 }, snapshot)
  const [segment] = responseSegments(envelope)
  assert.ok(segment?.type === 'citation')
  assert.equal(segment.annotation.sources[0]!.truncated, true)
  assert.match(JSON.stringify(evidenceItems(snapshot)), /do not infer coverage of the full source/)
  assert.equal(appendResearchEvidence(snapshot, 'repeat', result), snapshot)
  assert.throws(() => snapshotEvidence('bad', [{ ...snapshot.items[0]!, truncated: 'yes' as unknown as boolean }]), /truncation flag/)
})
