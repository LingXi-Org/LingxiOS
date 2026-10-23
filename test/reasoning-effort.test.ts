import assert from 'node:assert/strict'
import http from 'node:http'
import { it } from 'node:test'
import { createWorker, type HostPort, type WorkerOptions } from '../src/worker/index.js'
import { createLogger, type ModelCallObservation, type WorkItem } from '../src/index.js'
import { loadWorkerConfig } from '../src/config.js'
import { OpenAIChatDriver, type OpenAIDriverOptions } from '../src/model/openai.js'

// Failure inventory is recorded in docs/reasoning-effort-contract.md before implementation.
type WireRequest = Record<string, unknown>
const fixtureUsage = { prompt_tokens: 11, completion_tokens: 3 }

async function modelFixture(failFirst = false) {
  const requests: WireRequest[] = []
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WireRequest
    requests.push(body)
    if (failFirst && requests.length === 1) {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }))
      return
    }
    const payload = { model: 'reasoning-fixture', usage: fixtureUsage,
      choices: [{ finish_reason: 'stop', ...(body['stream'] ? { delta: { content: '{"ok":true}' } }
        : { message: { content: '{"ok":true}' } }) }] }
    response.writeHead(200, { 'content-type': body['stream'] ? 'text/event-stream' : 'application/json' })
    response.end(body['stream'] ? `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n` : JSON.stringify(payload))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { requests, baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    }) }
}

function wireEffort(body: WireRequest) {
  return [body['reasoning_effort'], body['enable_thinking'], body['thinking_budget']]
}

for (const auxiliaryStreaming of [false, true]) it(`public worker preserves low efforts across HTTP calls and retries (auxiliaryStreaming=${auxiliaryStreaming})`, async () => {
  const fixture = await modelFixture(true)
  const work: WorkItem = { id: 'reasoning-work', tenantId: 'tenant', agentId: 'agent', principalId: 'user', sessionId: 'session',
    kind: 'reasoning_probe', lane: 'interactive', triggerRef: 'fixture', fence: 1, homeEpoch: 1, leaseToken: 'fixture-lease' }
  const observations: ModelCallObservation[] = []
  let claimed = false, completed: string | undefined
  const unexpected = async (): Promise<never> => { throw new Error('unexpected fixture host operation') }
  const host: HostPort = {
    claimWork: async () => { if (claimed) return null; claimed = true; return work },
    heartbeat: async () => ({ ok: true }), emitEvent: async () => {},
    reserveModelCall: async () => ({ allowed: true, deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      remainingCalls: 10, remainingTokens: 100_000, remainingCostMicros: 1_000_000 }),
    recordModelUsage: async (_work, _call, _usage, observation) => { assert.ok(observation); observations.push(observation) },
    completeWork: async (_work, completion) => { completed = completion.status },
    verifyCandidate: unexpected, saveStep: unexpected, loadContext: unexpected, executeAction: unexpected,
    recoverCell: unexpected, recoverStep: unexpected, loadSession: unexpected, saveSession: unexpected,
    commitResult: unexpected, waitWork: unexpected, yieldWork: unexpected,
  }
  const options = {
    controlPlane: { connectWorker: () => host },
    model: { id: 'reasoning-fixture', apiKey: 'synthetic-only', baseUrl: fixture.baseUrl,
      reasoningEffort: 'low', compactionReasoningEffort: 'low', maxThinkingTokens: 0,
      ...(auxiliaryStreaming ? { auxiliaryStreaming } : {}),
      recovery: { maxAttempts: 2, totalTimeoutMs: 5000 } },
    kernelFactory: () => ({ execute: unexpected, close: () => {}, size: 0 }),
    logger: createLogger({ level: 'error', sink: () => {} }),
    processors: { reasoning_probe: { async process(_work, context) {
      assert.equal((await context.model.run({ instructions: 'Synthetic request.', items: [], tools: [], codeExecution: 'disabled', signal: context.signal })).text, '{"ok":true}')
      assert.deepEqual((await context.model.structured({ instructions: 'Return JSON.', input: {}, signal: context.signal })).value, { ok: true })
      assert.equal((await context.model.compact({ instructions: 'Synthetic request.', items: [], signal: context.signal })).value, '{"ok":true}')
    } } },
  } satisfies WorkerOptions
  let worker: ReturnType<typeof createWorker> | undefined
  try {
    worker = createWorker(options)
    assert.equal(await worker.runNext(), true)
    assert.equal(completed, 'completed')
    assert.deepEqual(fixture.requests.map(wireEffort), Array.from({ length: 4 }, () => ['low', false, undefined]))
    assert.deepEqual(fixture.requests.map(body => body['stream']), [true, true, auxiliaryStreaming, auxiliaryStreaming])
    assert.deepEqual(observations.map(item => [item.purpose, item.status, item.attempt]),
      [['agent-turn', 'failed', 1], ['agent-turn', 'succeeded', 2], ['structured', 'succeeded', 1], ['compaction', 'succeeded', 1]])
    assert.ok(observations.slice(1).every(item => item.usage?.available && item.usage.inputTokens === 11 && item.usage.outputTokens === 3))
    assert.equal(new Set(observations.map(item => item.configurationFingerprint)).size, 1)
  } finally { await worker?.stop(); await fixture.close() }
})

it('keeps main and compaction effort independent without changing existing compaction defaults', async () => {
  const fixture = await modelFixture()
  try {
    const main = new OpenAIChatDriver('reasoning-fixture', { apiKey: 'synthetic-only', baseUrl: fixture.baseUrl,
      reasoningEffort: 'low', maxThinkingTokens: 0 })
    await main.compact({ instructions: '', items: [] })
    const compaction = new OpenAIChatDriver('reasoning-fixture', { apiKey: 'synthetic-only', baseUrl: fixture.baseUrl,
      compactionReasoningEffort: 'low' })
    await compaction.run({ instructions: '', items: [], tools: [], codeExecution: 'disabled' })
    await compaction.structured({ instructions: 'Return JSON.', input: {} })
    await compaction.singleAttempt().compact({ instructions: '', items: [] })
    assert.deepEqual(fixture.requests.map(wireEffort), [
      [undefined, false, undefined], [undefined, undefined, undefined],
      [undefined, undefined, undefined], ['low', false, undefined],
    ])
  } finally { await fixture.close() }
})

it('pins explicit compaction effort in the provider fingerprint and preserves it in clones', () => {
  const options = { apiKey: 'synthetic-only', maxThinkingTokens: 0, reasoningEffort: 'low' as const }
  const original = new OpenAIChatDriver('fixture', options)
  const configured = new OpenAIChatDriver('fixture', { ...options, compactionReasoningEffort: 'low' })
  assert.notEqual(configured.configurationFingerprint, original.configurationFingerprint)
  assert.equal(configured.singleAttempt().configurationFingerprint, configured.configurationFingerprint)
  assert.notEqual(new OpenAIChatDriver('fixture', { ...options, compactionReasoningEffort: 'high' }).configurationFingerprint,
    configured.configurationFingerprint)
  const streamed = new OpenAIChatDriver('fixture', { ...options, auxiliaryStreaming: true })
  assert.notEqual(streamed.configurationFingerprint, original.configurationFingerprint)
  assert.equal(streamed.singleAttempt().configurationFingerprint, streamed.configurationFingerprint)
  assert.equal(new OpenAIChatDriver('fixture', { ...options, auxiliaryStreaming: false }).configurationFingerprint,
    original.configurationFingerprint)
  // Freeze both effort configurations under the new nullable-delta policy.
  // Their old snapshots remain explicit negatives, not silently accepted binds.
  const defaultModel = new OpenAIChatDriver('fixture', { apiKey: 'synthetic-only' })
  const highEffort = new OpenAIChatDriver('fixture', { apiKey: 'synthetic-only', reasoningEffort: 'high', maxThinkingTokens: 0 })
  assert.equal(defaultModel.configurationFingerprint, '887057b8d1330db739531a5539bae51bfa6fa3c4ec6cf43e79a1241d1b52d4cb')
  assert.notEqual(defaultModel.configurationFingerprint, 'c69171f62097093e89728df6c837f1088c7c258ef3e1c60d0cfdd053461c24ea')
  assert.equal(highEffort.configurationFingerprint, 'b937791b9270acf558f8d7b4140b565c6798ce7bbd290a6793da05d4f1a4184b')
  assert.notEqual(highEffort.configurationFingerprint, '37cc95e4784d66462f8449fce49ad659d57f2291d9f71392ac22b9a06151fb3b')
  assert.equal(highEffort.singleAttempt().configurationFingerprint, highEffort.configurationFingerprint)
})

it('accepts all documented effort values through the standalone worker configuration', () => {
  const env = { AGENT_OS_CONTROL_PLANE_URL: 'http://fixture.invalid', AGENT_OS_SERVICE_TOKEN: 'synthetic-only', AGENT_OS_MODEL_API_KEY: 'synthetic-only' }
  for (const value of ['low', 'high', 'max'] as const) {
    const config = loadWorkerConfig({ ...env, AGENT_OS_REASONING_EFFORT: ` ${value} `, AGENT_OS_COMPACTION_REASONING_EFFORT: value })
    assert.equal(config.model.reasoningEffort, value)
    assert.equal(config.model.compactionReasoningEffort, value)
  }
  assert.equal(Object.hasOwn(loadWorkerConfig(env).model, 'compactionReasoningEffort'), false)
  assert.equal(Object.hasOwn(loadWorkerConfig(env).model, 'auxiliaryStreaming'), false)
  assert.equal(loadWorkerConfig({ ...env, AGENT_OS_AUXILIARY_STREAMING: 'true' }).model.auxiliaryStreaming, true)
  assert.equal(loadWorkerConfig({ ...env, AGENT_OS_AUXILIARY_STREAMING: 'false' }).model.auxiliaryStreaming, false)
})

it('rejects unknown reasoning efforts at driver and CLI configuration boundaries', () => {
  for (const key of ['reasoningEffort', 'compactionReasoningEffort'] as const) for (const value of ['medium', '', 'LOW']) {
    const options = { apiKey: 'synthetic-only', [key]: value } as OpenAIDriverOptions
    assert.throws(() => new OpenAIChatDriver('fixture', options), new RegExp(key))
  }
  for (const key of ['AGENT_OS_REASONING_EFFORT', 'AGENT_OS_COMPACTION_REASONING_EFFORT']) {
    assert.throws(() => loadWorkerConfig({ [key]: 'medium' }), new RegExp(key))
  }
  assert.throws(() => new OpenAIChatDriver('fixture', { apiKey: 'synthetic-only', auxiliaryStreaming: 'true' } as unknown as OpenAIDriverOptions), /auxiliaryStreaming/)
  assert.throws(() => loadWorkerConfig({ AGENT_OS_AUXILIARY_STREAMING: 'invalid' }), /AGENT_OS_AUXILIARY_STREAMING/)
})
