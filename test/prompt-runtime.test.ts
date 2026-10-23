import assert from 'node:assert/strict'
import { it } from 'node:test'
import { compileContext, compileAuxiliaryPrompt, COMPACTION_PROMPT, textSha256, type ContextBlock } from '../src/context/compiler.js'
import { buildPromptContext, PROMPT_CONTRACT_VERSION } from '../src/prompts/provider.js'
import { DefaultRuntimePolicy } from '../src/runtime/policy.js'
import { DEFAULT_MODEL_BUDGET, executionModel, type ModelCallObservation } from '../src/model/execution.js'
import { OpenAIChatDriver } from '../src/model/openai.js'
import type { ModelDriver } from '../src/model/driver.js'
import type { TurnContext } from '../src/protocol/types.js'
import { executionSnapshot } from '../src/runtime/execution-policy.js'

const context: TurnContext = {
  work: { id: 'w', tenantId: 't', agentId: 'a', sessionId: 's', triggerRef: 'm', kind: 'turn', lane: 'interactive', fence: 1, homeEpoch: 1, leaseToken: 'token' },
  persona: { name: 'A', role: 'assistant', instructions: 'PRIVATE_PREFERENCE' },
  productRules: 'Trusted product policy.', capabilities: ['files'], grants: [{ name: 'files' }], messages: [],
}
const policy = new DefaultRuntimePolicy()
const product: ContextBlock = { source: 'product', version: '1', trust: 'product', truncated: false, cache: 'prefix', content: '规则：🧪' }

it('compiles deterministic sections with exact UTF-8 prefix boundaries and content-free diagnostics', () => {
  const blocks = [product, { ...product, source: 'grants', trust: 'platform' as const, cache: 'dynamic' as const, content: 'LIVE_GRANT' },
    { ...product, source: 'memory', trust: 'observation' as const, cache: 'dynamic' as const, content: 'PRIVATE_MEMORY' }]
  const compiled = compileContext(blocks)
  assert.deepEqual(compiled, compileContext(structuredClone(blocks)))
  const bytes = Buffer.from(compiled.instructions)
  assert.equal(compiled.manifest.instructionBytes, bytes.length)
  assert.equal(compiled.manifest.instructionsSha256, textSha256(compiled.instructions))
  assert.equal(compiled.manifest.prefix.sha256, textSha256(bytes.subarray(0, compiled.manifest.prefix.bytes).toString()))
  assert.equal(bytes.subarray(compiled.manifest.prefix.bytes).toString(), '\n\nLIVE_GRANT')
  assert.equal(compiled.manifest.sections.find(section => section.source === 'product')!.bytes, Buffer.byteLength(product.content))
  assert.doesNotMatch(JSON.stringify(compiled.manifest), /PRIVATE_MEMORY|LIVE_GRANT|规则/)
  assert.equal(JSON.parse((compiled.items[0] as { content: string }).content).content, 'PRIVATE_MEMORY')
})

it('fails closed on ambiguous, malformed, truncated, or misplaced instruction sections', () => {
  for (const blocks of [
    [product, product], [{ ...product, source: 'platform:identity' }], [{ ...product, version: '' }],
    [{ ...product, trust: 'system' }], [{ ...product, truncated: true }], [{ ...product, trust: 'observation' }],
    [{ ...product, cache: 'dynamic' }, { ...product, source: 'late' }],
  ]) assert.throws(() => compileContext(blocks as ContextBlock[]), /prompt|instructions|data/)
  assert.throws(() => compileAuxiliaryPrompt('review', ''), /trusted purpose/)
})

it('keeps dynamic grants and preferences outside the stable prefix and invalidates content without a version bump', () => {
  const first = buildPromptContext(context, policy, 0, 'v1', 'now')
  const revoked = buildPromptContext({ ...context, capabilities: [], grants: [], persona: { ...context.persona, instructions: 'CHANGED' } }, policy, 1, 'v1', 'later')
  assert.deepEqual(first.manifest!.prefix, revoked.manifest!.prefix)
  assert.notEqual(first.fingerprint, revoked.fingerprint)
  assert.match(revoked.systemInstructions, /"grants":\[\]/)
  assert.doesNotMatch(revoked.systemInstructions, /PRIVATE_PREFERENCE|CHANGED/)
  assert.equal(revoked.epoch, 1)
  assert.match(first.systemInstructions, /"codeExecution":"enabled"/)
  const disabled = buildPromptContext({ ...context, work: { ...context.work, meta: { codeExecution: 'disabled' } } }, policy, 0, 'v1')
  assert.match(disabled.systemInstructions, /"codeExecution":"disabled"/)
  assert.notEqual(first.fingerprint, disabled.fingerprint)
  const changed = buildPromptContext({ ...context, productRules: 'Changed trusted rules.' }, policy, 0, 'v1')
  assert.notEqual(first.manifest!.prefix.sha256, changed.manifest!.prefix.sha256)
  assert.notEqual(first.fingerprint, changed.fingerprint)
})

it('rebuilds restored snapshots from live inputs and does not leak state between tenants', () => {
  const stale = buildPromptContext(context, policy, 0)
  stale.systemInstructions = 'SPOOFED_SYSTEM'
  stale.persona.instructions = 'STALE_PERSONA'
  stale.blocks!.push({ ...product, source: 'SPOOFED_BLOCK' })
  const restored = buildPromptContext({ ...context, promptContextCandidate: stale, grants: [] }, policy, 3)
  assert.doesNotMatch(restored.systemInstructions, /SPOOFED|STALE_PERSONA/)
  assert.deepEqual(restored.persona, context.persona)
  assert.match(restored.systemInstructions, /"grants":\[\]/)
  const other = buildPromptContext({ ...context, work: { ...context.work, tenantId: 'other' }, productRules: 'OTHER_TENANT' }, policy, 0)
  assert.doesNotMatch(restored.systemInstructions, /OTHER_TENANT/)
  assert.notEqual(other.manifest!.prefix.sha256, restored.manifest!.prefix.sha256)
  assert.equal(buildPromptContext(context, policy, 0).fingerprint, buildPromptContext(context, policy, 9).fingerprint)
})

it('binds prompt identity to tool definitions and source versions without contaminating system instructions', () => {
  const base = buildPromptContext(context, policy, 0)
  const tool: NonNullable<TurnContext['tools']>[number] = { name: 'files__read', action: 'files.read', description: 'Read.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, effect: 'read', approval: false }
  const variants = [
    { ...context, tools: [tool] },
    { ...context, promptContextCandidate: { ...base, sourceVersions: { product: 'v2' } } },
  ]
  for (const variant of variants) {
    const compiled = buildPromptContext(variant, policy, 0)
    assert.deepEqual(compiled.manifest!.prefix, base.manifest!.prefix)
    assert.notEqual(compiled.fingerprint, base.fingerprint)
  }
  const a = buildPromptContext({ ...context, tools: [tool] }, policy, 0)
  const b = buildPromptContext({ ...context, tools: [{ ...tool, parameters: { ...tool.parameters, properties: { id: { type: 'string' } } } }] }, policy, 0)
  assert.notEqual(a.fingerprint, b.fingerprint)
})

it('reads the capability resolver once for each prompt snapshot', () => {
  let calls = 0
  class ChangingPolicy extends DefaultRuntimePolicy {
    override kernelCapabilities() { calls++; return [{ name: `grant-${calls}` }] }
  }
  const compiled = buildPromptContext({ ...context, tools: [{ name: 'grant-1__read', action: 'grant-1.read', description: 'Read.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, effect: 'read', approval: false }] }, new ChangingPolicy(), 0)
  assert.equal(calls, 1)
  assert.match(compiled.systemInstructions, /grant-1/)
})

// Failures: stale advisory grants advertise absent tools; a negative capability
// list replaces them; filtering changes host authorization or suppresses real tools.
it('advertises only registered authorized tools without changing advisory execution grants', () => {
  const stale = { ...context, productRules: '', capabilities: ['email', 'calendar'], grants: [{ name: 'email' }, { name: 'calendar' }] }
  const execution = executionSnapshot(stale, policy)
  assert.deepEqual(execution.grants, stale.grants)
  const prompt = buildPromptContext(stale, policy, 0, undefined, undefined, execution)
  assert.deepEqual(prompt.capabilities, [])
  assert.doesNotMatch(prompt.systemInstructions, /email|calendar|日历|邮件/i)
  assert.match(prompt.systemInstructions, /Use only exposed tools and granted methods/)
  assert.match(prompt.systemInstructions, /Never invent identifiers, receipts or resource state/)
  assert.deepEqual(execution.grants, stale.grants, 'prompt assembly must not mutate host authorization')
  const tool = { name: 'email__read', action: 'email.read', description: 'Read a message.',
    parameters: { type: 'object' as const, properties: {}, additionalProperties: false as const }, effect: 'read' as const, approval: false }
  const registered = buildPromptContext({ ...stale, tools: [tool] }, policy, 1)
  assert.deepEqual(registered.capabilities, ['email'], 'availability comes from the catalog, never a product blacklist')
  assert.match(registered.systemInstructions, /"methods":\["read"\]/)
  assert.doesNotMatch(registered.systemInstructions, /calendar/i)
})

it('records the exact auxiliary prompt used by every driver and rejects stale manifests before reserving budget', async () => {
  const observations: ModelCallObservation[] = []
  let reservations = 0
  const usage = { available: true, inputTokens: 1, outputTokens: 1 }
  const driver: ModelDriver = {
    run: async () => ({ text: 'ok', output: [], usage }),
    structured: async () => ({ value: {}, model: 'fake', usage }),
    compact: async request => {
      assert.equal(request.instructions, COMPACTION_PROMPT.instructions)
      assert.deepEqual(request.prompt, COMPACTION_PROMPT.manifest)
      return { value: '{}', model: 'fake', usage }
    },
  }
  const model = executionModel({ reserveModelCall: async () => {
    reservations++
    return { allowed: true, remainingCalls: 9, remainingTokens: 999999, remainingCostMicros: 999999, deadlineAt: new Date(Date.now() + 5000).toISOString() }
  }, recordModelUsage: async (_work, _id, _usage, observation) => { observations.push(observation!) } }, driver, context.work, DEFAULT_MODEL_BUDGET)
  const review = compileAuxiliaryPrompt('content-review', 'Return JSON with omissions.')
  await assert.rejects(model.structured({ instructions: 'ALTERED', prompt: review.manifest, input: {} }), /manifest does not match/)
  assert.equal(reservations, 0)
  await model.structured({ instructions: review.instructions, prompt: review.manifest, input: {} })
  await model.compact({ instructions: 'PRIVATE_PERSONA', items: [] })
  assert.deepEqual(observations.map(item => [item.prompt?.purpose, item.instructionsSha256]), [
    ['content-review', textSha256(review.instructions)], ['compaction', textSha256(COMPACTION_PROMPT.instructions)],
  ])
  assert.doesNotMatch(JSON.stringify(observations), /PRIVATE_PERSONA|Return JSON with omissions/)
})

it('sends only instructions and data to the provider, never local prompt manifests', async () => {
  const prompt = compileAuxiliaryPrompt('review', 'Return JSON.')
  const driver = new OpenAIChatDriver('fake', { apiKey: 'fake', fetchImpl: async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    assert.deepEqual(body.messages, [{ role: 'system', content: prompt.instructions }, { role: 'user', content: '{"evidence":"untrusted"}' }])
    assert.equal(body.prompt, undefined)
    assert.equal(body.tools, undefined)
    assert.doesNotMatch(String(init?.body), /instructionsSha256|prefix/)
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] })
  } })
  await driver.structured({ instructions: prompt.instructions, prompt: prompt.manifest, input: { evidence: 'untrusted' } })
})

it('does not charge local prompt manifests against the provider context window', async () => {
  const prompt = compileAuxiliaryPrompt('review', 'Return JSON.')
  prompt.manifest.sections.push({ source: 'diagnostic'.repeat(2000), version: '1', trust: 'observation', truncated: false, placement: 'data', sha256: '0'.repeat(64), bytes: 0 })
  let calls = 0
  const driver: ModelDriver = { contextWindowTokens: 2000, maxOutputTokens: 100,
    run: async () => { throw new Error('unexpected turn') }, compact: async () => { throw new Error('unexpected compaction') },
    structured: async () => { calls++; return { value: {}, model: 'fake', usage: { available: true, inputTokens: 20, outputTokens: 2 } } } }
  const model = executionModel({ reserveModelCall: async () => ({ allowed: true, remainingCalls: 9, remainingTokens: 999999, remainingCostMicros: 999999, deadlineAt: new Date(Date.now() + 5000).toISOString() }),
    recordModelUsage: async () => {} }, driver, context.work, DEFAULT_MODEL_BUDGET)
  await model.structured({ instructions: prompt.instructions, prompt: prompt.manifest, input: {} })
  assert.throws(() => model.structured({ instructions: prompt.instructions, prompt: prompt.manifest, input: { prompt: 'required data'.repeat(2000) } }), /context budget/)
  assert.equal(calls, 1)
})


// Direct execution has no implicit evaluator. The governing instructions must
// make the same-generation requirement check explicit, without inventing a wire contract.
it('pins the direct execution delivery instructions and their compiled identity', () => {
  const expected = 'Answer simple text requests directly in the exact requested format. Do not wrap them in assessment JSON or execute code merely to print the answer. Keep private reasoning and internal execution metadata out of user-facing text. For complex tasks, in the same generation check every deliverable, constraint, action and acceptance condition against the original request, ordered revisions and actual tool receipts before returning the result. Complete feasible authorized work with available tools before the final reply. Native runtime checks validate recorded actions, resources and artifacts; do not assume a model will review or rewrite your answer. Where the existing response contract supports status, preserve partial or blocked for known unmet requirements; otherwise state those gaps plainly without claiming completion.'
  const compiled = buildPromptContext(context,policy,0)
  assert.equal(PROMPT_CONTRACT_VERSION,'prompt-v3.3')
  assert.equal(compiled.sourceVersions['promptContract'],PROMPT_CONTRACT_VERSION)
  const section = compiled.manifest!.sections.find(section => section.source === 'platform:delivery')!
  assert.equal(section.sha256,textSha256(expected))
  assert.equal(section.bytes,Buffer.byteLength(expected))
  assert.ok(compiled.systemInstructions.includes(expected))
  assert.doesNotMatch(compiled.systemInstructions,/runtime independently reviews complex candidates/)
  assert.doesNotMatch(compiled.systemInstructions,/Record a derived checklist for multi-step or multi-deliverable work/)
})
