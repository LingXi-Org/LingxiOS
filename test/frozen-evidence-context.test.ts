import assert from 'node:assert/strict'
import { it } from 'node:test'
import { ControlPlaneService } from '../src/control-plane/service.js'
import { MemoryActionLedger, MemoryEventStore, MemoryModelBudgetStore, MemorySessionStore, MemoryWorkStore } from '../src/control-plane/memory-store.js'
import { MemoryStepStore } from '../src/control-plane/steps.js'
import { snapshotRequest } from '../src/context/request.js'
import { sessionKeyOf, type SessionRecord } from '../src/protocol/types.js'

// Failure inventory: docs/evidence-pagination-failure-model.md.
it('advertises only an authorized same-request frozen evidence snapshot, never metadata or a prior/revised request', async () => {
  const sessions = new MemorySessionStore(), options: unknown[] = []
  let revoked = false, authorizations = 0
  const service = new ControlPlaneService({ work: new MemoryWorkStore(), sessions, steps: new MemoryStepStore(),
    events: new MemoryEventStore(), actions: new MemoryActionLedger(), modelBudgets: new MemoryModelBudgetStore(),
    contextProvider: {
      authorizeRequest: async () => { authorizations++; if (revoked) throw new Error('source revoked') },
      loadContext: async (_work, _signal, loadOptions) => { options.push(loadOptions); return {
        persona: { name: 'Agent', role: '', instructions: '' }, capabilities: [],
        messages: [{ ref: 'request', authorId: 'human', authorName: 'Human', authorKind: 'human', body: 'Explain the source.', createdAt: 'now' }],
        evidence: [{ marker: 'S1', sourceId: 'source', sourceVersion: 'v1', chunkId: 'excerpt', title: 'Synthetic source', excerpt: 'Verified source text.' }],
      } },
    }, capabilityResolver: { resolve: async () => [] }, actionExecutor: { prepare: async () => {}, execute: async () => ({ ok: false }) },
    delivery: { onEvent: async () => {}, deliverMessage: async () => {} } })
  await service.enqueue({ id: 'first', tenantId: 'tenant', agentId: 'agent', principalId: 'human', sessionId: 'session', kind: 'turn', lane: 'interactive',
    triggerRef: 'request', meta: { text: 'Explain the source.', frozenEvidence: { workId: 'first', requestVersion: 1, snapshotId: 'forged' } } })
  const work = (await service.claim('worker'))!
  const initial = await service.loadContext(work)
  assert.equal(Reflect.get(options.at(-1) as object, 'frozenEvidence'), undefined, 'untrusted metadata cannot manufacture frozen evidence')
  const session: SessionRecord = { key: sessionKeyOf(work), tenantId: work.tenantId, agentId: work.agentId, sessionId: work.sessionId,
    history: [], appliedWorkIds: [work.id], revision: 0, compactionEpoch: 0, request: snapshotRequest(initial) }
  const save = async () => { const result = await sessions.save(session); assert.equal(result.ok, true); if (result.ok) session.revision = result.revision }
  await save()
  await service.loadContext(work)
  assert.deepEqual(Reflect.get(options.at(-1) as object, 'frozenEvidence'), { workId: work.id, requestVersion: 1, snapshotId: session.request!.evidence.id })
  assert.ok(authorizations > 0)
  const beforeDenied = options.length
  revoked = true
  await assert.rejects(service.loadContext(work), /source revoked/)
  assert.equal(options.length, beforeDenied, 'a stale hint cannot bypass current source authorization')
  revoked = false
  session.request!.revisions.push({ id: 'revision', text: 'Use another source.', createdAt: 'now' })
  await save(); await service.loadContext(work)
  assert.equal(Reflect.get(options.at(-1) as object, 'frozenEvidence'), undefined, 'a requirement revision must not reuse first-version retrieval')
  session.request!.revisions = []
  session.request!.evidence.items = []
  await save(); await service.loadContext(work)
  assert.equal(Reflect.get(options.at(-1) as object, 'frozenEvidence'), undefined, 'empty evidence must not suppress initial retrieval or a fast-to-deep upgrade')
  session.request = snapshotRequest(initial)
  await save()
  await service.complete(work, { status: 'failed', terminalReason: 'execution_failed' })
  await service.enqueue({ id: 'second', tenantId: 'tenant', agentId: 'agent', principalId: 'human', sessionId: 'session', kind: 'turn', lane: 'interactive',
    triggerRef: 'request', meta: { text: 'Explain a different source.' } })
  const next = (await service.claim('worker'))!
  assert.equal(next.id, 'second')
  await service.loadContext(next)
  assert.equal(Reflect.get(options.at(-1) as object, 'frozenEvidence'), undefined, 'prior request evidence cannot suppress a new request retrieval')
})
