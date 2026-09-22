import assert from 'node:assert/strict'
import { it } from 'node:test'
import { JevClient, accepted, decideOrFallback, executionDecision, parseDecisionResult, yesNo, type DecisionAnswer, type DecisionDriver, type DecisionRequest } from '../src/model/decision.js'
import { ModelBudgetExceededError, LeaseLostError } from '../src/errors.js'
import { reviewMemoryDecision, verifyMemoryDecision, rerankMemoryContext } from '../src/memory/decision.js'
import { decisionContentCheck } from '../src/outcome/decision-check.js'
import { snapshotMemories } from '../src/memory/context.js'
import type { WorkItem } from '../src/protocol/types.js'
import type { ModelCallObservation } from '../src/model/execution.js'
import { DEFAULT_MODEL_BUDGET, modelPricing } from '../src/model/execution.js'
import { ControlPlaneService } from '../src/control-plane/service.js'
import { MemoryActionLedger, MemoryEventStore, MemoryModelBudgetStore, MemorySessionStore, MemoryWorkStore } from '../src/control-plane/memory-store.js'
import { MemoryStepStore } from '../src/control-plane/steps.js'

const request: DecisionRequest = { purpose: 'memory-write-review', version: '1', state: '请记住我喜欢中文解释。', questions: { supported: yesNo('Is the preference explicit?') } }
const choice = (selected = 'yes'): DecisionAnswer => ({ type: 'choice', choice: selected, confidence: 1,
  probabilities: { yes: Number(selected === 'yes'), no: Number(selected === 'no'), uncertain: Number(selected === 'uncertain') } })
const response = () => ({ model: 'jev-1.13.0', answers: { supported: choice() }, usage: { input_tokens: 1000, output_tokens: 20 } })
const driver = (answers: (request: DecisionRequest) => Record<string, DecisionAnswer>, mode: 'active' | 'shadow' = 'active'): DecisionDriver => ({
  modelId: 'jev-1.13.0', configurationFingerprint: 'fixture', inputCostMicrosPerMillion: 42_000, mode: () => mode,
  decide: async request => ({ model: 'jev-1.13.0', answers: answers(request), usage: { available: true, inputTokens: 1000, outputTokens: 20 } }),
})

it('control-plane Jev pricing overrides generic and worker prices and stays frozen across settlement', async () => {
  const modelBudget = { ...DEFAULT_MODEL_BUDGET, inputCostMicrosPerMillion: 1_000_000, outputCostMicrosPerMillion: 2_000_000 }
  const modelPrices = { 'jev-1.13.0': { inputCostMicrosPerMillion: 42_000, outputCostMicrosPerMillion: 0 } }
  const service = new ControlPlaneService({ modelBudget, modelPrices, modelBudgets: new MemoryModelBudgetStore(), steps: new MemoryStepStore(),
    work: new MemoryWorkStore(), sessions: new MemorySessionStore(), events: new MemoryEventStore(), actions: new MemoryActionLedger(),
    contextProvider: { loadContext: async () => { throw new Error('unexpected') } }, capabilityResolver: { resolve: async () => [] },
    actionExecutor: { prepare: async () => {}, execute: async () => ({ ok: false }) }, delivery: { onEvent: async () => {}, deliverMessage: async () => {} } })
  await service.enqueue({ id: 'priced', tenantId: 't', agentId: 'a', principalId: 'u', sessionId: 's', kind: 'turn', lane: 'interactive', triggerRef: 'm' })
  const work = (await service.claim('worker'))!
  const limits = { ...modelBudget, model: 'jev-1.13.0', deadlineAt: new Date(Date.now() + 60_000).toISOString(), reservedTokens: 1000,
    reservedInputTokens: 1000, reservedOutputTokens: 0, reservedCostMicros: 0, pricing: modelPricing(DEFAULT_MODEL_BUDGET) }
  assert.equal((await service.reserveModelCall(work, 'jev', limits)).remainingCostMicros, modelBudget.maxCostMicros - 42)
  modelPrices['jev-1.13.0'].inputCostMicrosPerMillion = 500_000
  await service.recordModelUsage(work, 'jev', { inputTokens: 1000, outputTokens: 0, costMicros: 0 })
  const remaining = await service.reserveModelCall(work, 'inspect', { ...limits, reservedTokens: 0, reservedInputTokens: 0 })
  assert.equal(remaining.remainingCostMicros, modelBudget.maxCostMicros - 42)
})

it('validates protocol, rejects missing answers, aliases, unknown usage and malformed distributions', () => {
  assert.equal(parseDecisionResult(response(), request.questions, 'jev-1.13.0').usage.inputTokens, 1000)
  for (const value of [{ ...response(), answers: {} }, { ...response(), model: 'jev-latest' }, { ...response(), usage: {} },
    { ...response(), answers: { supported: { ...choice(), probabilities: { yes: 1, no: 1, uncertain: 0 } } } },
    { ...response(), answers: { supported: { ...choice(), choice: 'outside' } } }]) assert.throws(() => parseDecisionResult(value, request.questions, 'jev-1.13.0'))
  assert.equal(accepted(choice()), true)
  assert.equal(accepted({ ...choice(), confidence: 0.5 } as DecisionAnswer), false)
})

it('uses the pinned official protocol, bounds inputs and never retries a provider failure or leaks its body', async () => {
  let calls = 0
  const client = new JevClient({ apiKey: 'test-only', fetchImpl: async (url, options) => {
    calls++
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone')
    assert.equal(JSON.parse(options!.body as string).model, 'jev-1.13.0')
    return new Response('private-prompt-and-secret', { status: 429 })
  } })
  await assert.rejects(client.decide(request), /^Error: jev_http_429$/)
  assert.equal(calls, 1)
  await assert.rejects(client.decide({ ...request, state: 'x'.repeat(31_000) }), /context limit/)
  assert.equal(calls, 1)
  assert.throws(() => new JevClient({ apiKey: 'test', baseUrl: 'https://untrusted.invalid/v1' }), /configuration/)
})

it('bounds response bodies and honors cancellation without a paid retry', async () => {
  const oversized = new JevClient({ apiKey: 'test', fetchImpl: async () => new Response('x'.repeat(256_001)) })
  await assert.rejects(oversized.decide(request), /response_limit/)
  const stopped = new AbortController(); stopped.abort()
  let called = false
  const client = new JevClient({ apiKey: 'test', fetchImpl: async () => { called = true; return Response.json(response()) } })
  await assert.rejects(client.decide({ ...request, signal: stopped.signal }))
  assert.equal(called, false)
})

it('settles Jev usage and price into the durable root ledger, and records failed unknown usage', async () => {
  const observations: ModelCallObservation[] = []
  const reservations: unknown[] = []
  const host = { reserveModelCall: async (_work: unknown, _id: unknown, input: unknown) => {
    reservations.push(input)
    return { allowed: true, deadlineAt: new Date(Date.now() + 60_000).toISOString(), remainingCalls: 10, remainingTokens: 100000, remainingCostMicros: 1000000 }
  }, recordModelUsage: async (_work: unknown, _id: unknown, _usage: unknown, observation?: ModelCallObservation) => { observations.push(observation!) } }
  const work = { id: 'work', tenantId: 'tenant', principalId: 'human', agentId: 'agent', sessionId: 'session', fence: 1 } as WorkItem
  await executionDecision(host, driver(() => ({ supported: choice() })), work).decide(request)
  assert.equal(reservations.length, 1)
  assert.equal(observations[0]!.purpose, 'decision')
  assert.equal(observations[0]!.cost!.amountMicros, 42)
  assert.equal(observations[0]!.cost!.pricing.outputMicrosPerMillion, 0)
  const unavailable = new JevClient({ apiKey: 'test', fetchImpl: async () => Response.json({ ...response(), usage: {} }) })
  await assert.rejects(executionDecision(host, unavailable, work).decide(request), /usage/)
  assert.equal(observations[1]!.status, 'failed')
  assert.equal(observations[1]!.usage!.available, false)
  assert.equal(observations.length, 2)
})

it('rejects unsafe memory despite other perfect answers and shadow never changes the legacy verdict', async () => {
  const state = { request: { originalText: 'Remember my preference', revisions: [], delegated: false }, action: 'memory.apply', args: {}, documents: [] }
  const answers = (r: DecisionRequest) => Object.fromEntries(Object.keys(r.questions).map(key => [key, choice(key === 'safe' ? 'no' : 'yes')]))
  assert.deepEqual(await reviewMemoryDecision(driver(answers), state), { approved: false, explicit: true, confidence: 1 })
  assert.equal(await reviewMemoryDecision(driver(answers, 'shadow'), state), undefined)
  const result = await verifyMemoryDecision(driver(answers), { changes: [{}], candidates: [] }, new AbortController().signal)
  assert.equal(result!.approved, false)
})

it('reranks only recall while preserving core and stored identities', async () => {
  const recalled = [{ id: 'a', path: 'a', excerpt: 'one', score: 0 }, { id: 'b', path: 'b', excerpt: 'two', score: 0 }]
  const memory = snapshotMemories({ status: 'available', core: [], directory: [], recalled: recalled as never, strategies: [],
    omitted: { core: 0, directory: 0, recalled: 0, strategies: 0 }, budget: { ratio: 0.1, maxTokens: 1000 }, retrieval: ['keyword'] })
  const model = driver(() => Object.fromEntries([0, 1].map(i => [`item_${i}`, { type: 'score', score: i, confidence: 1, probabilities: {}, legend: {} } as DecisionAnswer])))
  const result = await rerankMemoryContext(model, memory, 'query', new AbortController().signal)
  assert.deepEqual(result.recalled.map(row => row.id), ['b', 'a'])
  assert.deepEqual(memory.recalled.map(row => row.id), ['a', 'b'])
  assert.deepEqual(result.core, memory.core)
  assert.notEqual(result.id, memory.id)
})

it('content checks preserve original requirements and turn unsupported citations into grounded findings', async () => {
  const seen: DecisionRequest[] = []
  const model = driver(r => { seen.push(r); return Object.fromEntries(Object.keys(r.questions).map(key => [key,
    { type: 'choice', choice: key.startsWith('requirement') ? 'satisfied' : key.startsWith('citation') ? 'unsupported' : 'none', confidence: 1,
      probabilities: { satisfied: 1, unknown: 1, none: 1 } } as DecisionAnswer])) })
  const input = { originalText: 'Explain the evidence.', revisions: [], body: '[Unsupported claim](#cite-S1)', evidence: { items: [{ marker: 'S1', excerpt: 'Unrelated text' }] } }
  const result = await decisionContentCheck(model, input, new AbortController().signal)
  assert.equal(result!.limitations[0]!.quote, 'Unsupported claim')
  assert.ok(Object.hasOwn(seen[0]!.questions, 'citation_0'))
  assert.ok(await decisionContentCheck(model, { ...input, originalText: 'x'.repeat(2001) }, new AbortController().signal))
})

it('falls back on uncertainty and provider failure, but never on clear rejection, budget, lease or persistence failures', async () => {
  const uncertain = driver(r => Object.fromEntries(Object.keys(r.questions).map(id => [id, { ...choice(), confidence: 0.7 }])))
  assert.equal(await decideOrFallback(uncertain, request), undefined)
  const rejecting = driver(() => ({ supported: choice('no'), ambiguous: choice('uncertain') }))
  assert.ok(await decideOrFallback(rejecting, request))
  const unavailable = { ...uncertain, decide: async () => { throw new Error('jev_http_429') } }
  assert.equal(await decideOrFallback(unavailable, request), undefined)
  for (const failure of [new ModelBudgetExceededError('spent'), new LeaseLostError(), new Error('database unavailable')]) {
    await assert.rejects(decideOrFallback({ ...uncertain, decide: async () => { throw failure } }, request), error => error === failure)
  }
  const summaries: unknown[] = []
  await decideOrFallback({ ...uncertain, recordDecision: async summary => { summaries.push(summary) } }, request)
  assert.equal(summaries.length, 1)
  assert.ok(!JSON.stringify(summaries).includes('请记住'))
})

it('covers every requirement across bounded batches without changing the original text', async () => {
  const seen: DecisionRequest[] = []
  const d = driver(r => { seen.push(r); return Object.fromEntries(Object.keys(r.questions).map(id => [id,
    { type: 'choice', choice: id.startsWith('requirement') ? 'satisfied' : 'none', confidence: 1, probabilities: {} } as DecisionAnswer])) })
  const result = await decisionContentCheck(d, { originalText: Array.from({ length: 70 }, (_, i) => `要求${i}。`).join(''), revisions: [], body: '交付。' }, new AbortController().signal)
  assert.deepEqual(result?.missing, [])
  assert.equal(seen.length, 3)
  assert.equal(seen.reduce((n, r) => n + Object.keys(r.questions).filter(id => id.startsWith('requirement')).length, 0), 70)
})
