import assert from 'node:assert/strict'
import { it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { AgentRuntime } from '../src/runtime/runtime.js'
import { ModelDriverError } from '../src/errors.js'
import { OpenAIChatDriver } from '../src/model/openai.js'
import { publicModelDiagnostics } from '../src/model/diagnostics.js'
import { createLogger } from '../src/logging.js'
import { PgEventStore } from '../src/control-plane/pg-store.js'
import type { HostPort } from '../src/host/port.js'
import type { ModelDriver } from '../src/model/driver.js'
import type { ModelCallObservation } from '../src/model/execution.js'
import type { RunEvent, TurnContext, WorkCompletion } from '../src/protocol/types.js'
import { durableProtocol } from './protocol-fixture.js'

// Failure model: docs/evidence/issue-216-diagnostic-privacy/FAILURE-MODEL.md.
// Actual runtime/event serializer/logger; local synthetic content only.
const unexpected = async (): Promise<never> => { throw new Error('unexpected fixture operation') }
const modes = ['memory-success','memory-failed','memory-unknown','memory-throw','driver-generic-memory','driver-generic-no-memory',
  'driver-diagnostics','recovered-protocol-diagnostics','completed-diagnostics','provider-finish-reason','heartbeat'] as const
for (const mode of modes) it(`keeps diagnostic copies content-free while preserving protected recovery (${mode})`, async () => {
  const marker = `SYNTHETIC_${randomUUID().replaceAll('-','')}`
  const contains = (value: unknown) => JSON.stringify(value)?.includes(marker) ?? false
  const work: TurnContext['work'] = { id: mode,tenantId: 't',agentId: 'a',principalId: 'u',sessionId: mode,triggerRef: 'm',kind: 'turn',lane: 'interactive',fence: 1,homeEpoch: 1,leaseToken: 'synthetic' }
  const memory = mode !== 'driver-generic-no-memory' && mode !== 'completed-diagnostics'
  const tool = mode.startsWith('memory-')
  const document = { id: 'memory-id',tenantId: 't',scopeType: 'user',scopeId: 'u',path: 'p.md',title: 'Memory',description: 'Memory',body: marker,
    layer: 'core' as const,kind: 'preference',origin: 'explicit' as const,locked: true,version: 1,status: 'active' as const,sources: [],validUntil: null,updatedAt: '2026-10-20T00:00:00Z' }
  const events: RunEvent[] = [], serialized: unknown[] = [], logs: string[] = [], inputs: unknown[] = [], outputs: unknown[] = []
  const observations: ModelCallObservation[] = [], completions: WorkCompletion[] = []
  let calls = 0, heartbeats = 0, commits = 0
  const protocol = durableProtocol(observation => observations.push(observation))
  const store = new PgEventStore({ connect: unexpected,query: async (_sql,params) => {
    serialized.push(params?.[7]); return { rows: [{ run_id: mode }],rowCount: 1 }
  } })
  const host: HostPort = { ...protocol,claimWork: async () => null,
    heartbeat: async () => { heartbeats++; if (mode === 'heartbeat') throw new Error(marker,{ cause: new Error(marker) }); return { ok: true } },
    loadContext: async () => ({ work,persona: { name: 'Fixture',role: 'assistant',instructions: '' },capabilities: memory ? ['memory'] : [],
      messages: [{ ref: 'm',authorId: 'u',authorName: 'Fixture',authorKind: 'human',body: memory ? 'Hello' : marker,createdAt: 'now' }],
      ...(memory ? { memory: { id: 'snapshot',status: 'available' as const,core: [document],directory: [],recalled: [],strategies: [],
        omitted: { core: 0,directory: 0,recalled: 0,strategies: 0 },budget: { ratio: .08,maxTokens: 8000 },retrieval: [] } } : {}),
      ...(tool ? { tools: [{ action: 'memory.read',name: 'memory__read',description: 'Read',effect: 'read' as const,approval: false,parameters: { type: 'object',properties: {},additionalProperties: false } }] } : {}),
    }),loadSession: async () => null,saveSession: async () => {},
    saveStep: async (w,step) => { outputs.push(step.output); await protocol.saveStep(w,step) },
    executeAction: async () => {
      if (mode === 'memory-throw') throw new Error(marker,{ cause: new Error(marker) })
      if (mode === 'memory-failed' || mode === 'memory-unknown') return { ok: false,executionState: mode === 'memory-unknown' ? 'unknown' : 'no_effect',error: marker,code: 'synthetic_failure' }
      return { ok: true,executionState: 'succeeded',value: { document: { ...document,body: undefined },body: marker,offset: 0,nextOffset: null } }
    },emitEvent: async (_w,event) => { events.push(event); await store.append({ ...event,tenantId: 't',agentId: 'a',recordedAt: new Date().toISOString() }) },
    commitResult: async () => { commits++ },completeWork: async (_w,value) => { completions.push(value) },yieldWork: async () => {},
  }
  const diagnostics = { kind: 'provider' as const,category: 'authorization' as const,status: 401,finishReasons: ['length',marker],
    usage: { available: true,inputTokens: 20,outputTokens: 10 },privateNested: { body: marker } }
  const synthetic: ModelDriver = { modelId: 'synthetic',structured: unexpected,compact: unexpected,run: async request => {
    calls++; inputs.push(request.items)
    if (mode.startsWith('driver-generic')) throw new Error(marker,{ cause: new Error(marker) })
    if (mode === 'driver-diagnostics') throw new ModelDriverError(marker,diagnostics,{ cause: new Error(marker) })
    if (mode === 'recovered-protocol-diagnostics' && calls === 1) {
      const protocolDiagnostics = { kind: 'protocol' as const,category: 'protocol' as const,protocolCode: 'tool_identity_invalid' as const,
        finishReasons: ['tool_calls',marker],usage: { available: true,inputTokens: 20,outputTokens: 10 },
        message: marker,rawPayload: { body: marker },cause: { message: marker } }
      throw new ModelDriverError(marker,protocolDiagnostics,{ cause: new Error(marker) })
    }
    if (tool && calls === 1) return { text: '',output: [{ type: 'function_call',callId: 'call',name: 'memory__read',arguments: '{}' }],usage: { available: true,inputTokens: 20,outputTokens: 10 } }
    return { text: 'Hello.',output: [],usage: { available: true,inputTokens: 20,outputTokens: 10 },
      ...(mode === 'completed-diagnostics' ? { diagnostics: { finishReasons: ['stop'],providerDurationMs: 10,privateNested: { body: marker } } } : {}) }
  } }
  const provider = new OpenAIChatDriver(`privacy-${randomUUID()}`,{ apiKey: 'synthetic',maxAttempts: 1,recovery: { maxAttempts: 1,totalTimeoutMs: 1000 },fetchImpl: async () => {
    calls++; return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello.' },finish_reason: marker }],usage: { prompt_tokens: 20,completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
  } })
  await new AgentRuntime(host,mode === 'provider-finish-reason' ? provider : synthetic,{ execute: unexpected },{ logger: createLogger({ sink: line => logs.push(line) }) }).runWork(work)
  // Keep the original protected state useful; fixing telemetry must not erase it.
  if (mode !== 'heartbeat' && mode !== 'provider-finish-reason') assert.equal(contains(inputs),true,'authorized model input remains intact')
  if (tool && mode !== 'memory-throw') assert.equal(contains(outputs),true,'protected step output retains the original memory/error')
  if (mode === 'memory-throw') {
    // A thrown host error has no returned receipt to persist. Keep that distinction.
    assert.equal(calls,1)
    assert.equal(events.some(event => event.kind === 'tool.completed'),false)
    assert.equal(completions[0]?.status,'failed')
  }
  if (mode === 'heartbeat') { assert.equal(calls,0); assert.equal(heartbeats,1); assert.equal(completions.length,0) }
  if (mode === 'memory-failed' || mode === 'memory-unknown') {
    const receipt = events.find(event => event.kind === 'tool.completed')?.data['result'] as Record<string,unknown>
    assert.equal(receipt['status'],mode === 'memory-unknown' ? 'unknown' : 'failed')
    assert.equal(receipt['reconciliationRequired'],mode === 'memory-unknown' ? true : undefined)
  }
  if (mode === 'driver-diagnostics') {
    assert.equal(observations[0]?.failure?.category,'authorization'); assert.equal(observations[0]?.failure?.status,401)
    assert.equal(observations[0]?.usage?.outputTokens,10)
    assert.equal(diagnostics.finishReasons[1],marker,'diagnostic projection does not mutate the original driver failure')
    const safe = events.find(event => event.kind === 'run.failed')?.data['modelDiagnostics'] as Record<string,unknown>
    assert.equal(safe['status'],401); assert.equal(safe['category'],'authorization')
    assert.ok((safe['finishReasons'] as unknown[]).includes('length'))
    assert.deepEqual(events.find(event => event.kind === 'model.failed')?.data['modelDiagnostics'],safe)
  }
  if (mode === 'recovered-protocol-diagnostics') {
    assert.equal(calls,2,'a bounded protocol correction still recovers once')
    assert.equal(events.some(event => event.kind === 'run.failed'),false,'recovered failures have no terminal failure event')
    assert.equal(commits,1,'the recovered answer reaches the normal final commit')
    const failed=events.find(event => event.kind === 'model.failed')
    assert.equal(failed?.visibility,'internal')
    assert.deepEqual(failed?.data['modelDiagnostics'],{kind:'protocol',category:'protocol',protocolCode:'tool_identity_invalid',
      finishReasons:['tool_calls','unknown'],usage:{available:true,inputTokens:20,outputTokens:10}})
  }
  if (mode === 'completed-diagnostics') {
    const safe = events.find(event => event.kind === 'model.completed')?.data['diagnostics'] as Record<string,unknown>
    assert.deepEqual(safe['finishReasons'],['stop'])
    assert.equal(typeof safe['providerDurationMs'],'number')
  }
  if (mode === 'provider-finish-reason') { assert.equal(calls,1); assert.equal(completions[0]?.status,'failed'); assert.equal(observations[0]?.usage?.outputTokens,10) }
  assert.equal(contains(events),false,'event diagnostic copies must not echo input or arbitrary diagnostics')
  assert.equal(contains(serialized),false,'PgEventStore serialization must remain content-free')
  assert.equal(contains(logs),false,'JSON logger must not echo heartbeat errors or causes')
  assert.equal(contains(observations),false,'model ledger keeps structured classification only')
  assert.equal(contains(completions),false,'terminal error remains content-free')
})

it('projects bounded diagnostic metadata without changing the original recovery object', () => {
  const original = { kind: 'provider', category: 'rate_limit', status: 429, requestId: 'private-correlation',
    attempts: 2, retryAfterMs: 123, providerDurationMs: 12.5, providerFirstContentMs: 3,
    providerCode: 'rate_limit_exceeded', finishReasons: ['stop','length','tool_calls','content_filter','function_call','private-content'],
    usage: { available: true, inputTokens: 5, outputTokens: 8, cachedInputTokens: 1, reasoningTokens: 2, body: 'private-content' },
    nested: { body: 'private-content' } }
  const before = structuredClone(original)
  const projected = publicModelDiagnostics(original)
  assert.deepEqual(projected, { kind: 'provider', category: 'rate_limit', status: 429,
    attempts: 2, retryAfterMs: 123, providerDurationMs: 12.5, providerFirstContentMs: 3,
    providerCode: 'rate_limit_exceeded', finishReasons: ['stop','length','tool_calls','content_filter','function_call','unknown'],
    usage: { available: true,inputTokens: 5,outputTokens: 8,cachedInputTokens: 1,reasoningTokens: 2 } })
  assert.deepEqual(original,before)
  assert.notEqual(projected['usage'],original.usage)
})

it('drops malformed diagnostic fields and bounds reasons without converting failures to success', () => {
  const projected = publicModelDiagnostics({ kind: 'private-content', category: 'private-content', status: 'private-content',
    attempts: .5, retryAfterMs: Infinity, providerDurationMs: -1, providerFirstContentMs: Number.MAX_VALUE,
    providerCode: 'private-content', finishReasons: Array(100).fill({ body: 'private-content' }),
    usage: { available: true,inputTokens: 'private-content',outputTokens: 1 },body: 'private-content' })
  assert.deepEqual(projected,{ finishReasons: Array(32).fill('unknown') })
  assert.deepEqual(publicModelDiagnostics(null),{})
})
