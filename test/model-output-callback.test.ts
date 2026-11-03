import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createHash } from 'node:crypto'
import { LeaseLostError, ModelBudgetExceededError, ModelDriverError } from '../src/errors.js'
import { OpenAIChatDriver } from '../src/model/openai.js'
import { publicModelDiagnostics } from '../src/model/diagnostics.js'
import { modelFailure } from '../src/model/recovery.js'
import { DEFAULT_MODEL_BUDGET, executionModel, type ModelCallObservation } from '../src/model/execution.js'
import { AnswerSegmentSet } from '../src/runtime/answer-segments.js'
import { PublicTextPublicationError, isPublicTextPublicationFailure, PublicTextSafetyError } from '../src/runtime/public-text.js'
import type { WorkItem } from '../src/protocol/types.js'

const marker = 'SYNTHETIC_PRIVATE_CALLBACK_TEXT'
const usage = { prompt_tokens: 7, completion_tokens: 9 }
let sequence = 0
function driver(operation = { kind: 'append', supersedes: [] as string[] }, measured = true, count = () => {}) {
  return new OpenAIChatDriver('synthetic-output-callback-' + ++sequence, { apiKey: 'synthetic', maxAttempts: 1,
    publicTextProtocol: 'purpose-json-v3', publicTextContinuation: 'typed-message-v1', publicAnswerTool: 'native-v3',
    capabilities: { parallelTools: true, jsonObjectWithTools: false }, fetchImpl: async () => {
      count()
      return new Response('data: ' + JSON.stringify({ ...(measured ? { usage } : {}), choices: [{
        finish_reason: 'tool_calls', delta: { tool_calls: [{ index: 0, id: 'synthetic-call', type: 'function', function: {
          name: 'public_answer', arguments: JSON.stringify({ operation, answer: 'Synthetic answer', outcome: { status: 'satisfied', gaps: [] } }) } }] } }] }) + '\n\ndata: [DONE]\n\n')
    } })
}
const request = { instructions: 'Synthetic only', items: [], tools: [], codeExecution: 'disabled' as const }

for (const measured of [true, false]) it(`classifies an actual missing-source replacement callback as local output (usage=${measured})`, async () => {
  const sources = new AnswerSegmentSet('synthetic-run', 1, 1)
  sources.seal({ identity: { version: 3, purpose: 'answer', messageId: sources.messageId, segmentId: 'kept', partId: 'kept',
    requestVersion: 1, fence: 1, attemptId: 'prefix', partIndex: 1, operation: 'append', supersedes: [] },
    text: 'Kept.', bodyHash: createHash('sha256').update('Kept.').digest('hex') })
  let operations = 0, deltas = 0
  let rejected: unknown
  await assert.rejects(driver({ kind: 'replace', supersedes: [marker] }, measured).run({ ...request,
    onTextOperation: operation => { operations++; try { sources.prepare(operation, 'candidate') } catch (error) { rejected = error; throw error } },
    onTextDelta: () => { deltas++ } }), error => {
    if (!measured) {
      assert.equal(error, rejected)
      assert.ok(error instanceof Error && !(error instanceof ModelDriverError))
      assert.equal(modelFailure(error).category, 'unknown'); assert.equal(modelFailure(error).retryable, false)
      return true
    }
    assert.ok(error instanceof ModelDriverError)
    assert.equal(error.cause, rejected)
    assert.equal(error.diagnostics.kind, 'output'); assert.equal(error.diagnostics.outputCallback, 'operation')
    assert.equal(error.diagnostics.category, 'unknown'); assert.equal(modelFailure(error).retryable, false)
    assert.equal(error.diagnostics.usage?.available === true, measured)
    assert.doesNotMatch(JSON.stringify(publicModelDiagnostics(error.diagnostics)), /SYNTHETIC_PRIVATE|replacement targets/)
    return true
  })
  assert.deepEqual({ operations, deltas, activeSources: sources.context.segmentIds }, { operations: 1, deltas: 0, activeSources: ['kept'] })
  assert.equal(sources.assemble().body, 'Kept.')
})

it('settles measured output failure once without retry or a successful result', async () => {
  let calls = 0, reserved = 0
  const observations: ModelCallObservation[] = []
  const work = { id: 'work', tenantId: 'tenant', agentId: 'agent', sessionId: 'session', fence: 1 } as WorkItem
  const model = executionModel({ reserveModelCall: async () => {
    reserved++; return { allowed: true, deadlineAt: new Date(Date.now() + 5000).toISOString(), remainingCalls: 10, remainingTokens: 100000, remainingCostMicros: 1000000 }
  }, recordModelUsage: async (_work, _id, _settlement, observation) => { if (observation) observations.push(observation) } },
  driver(undefined, true, () => { calls++ }), work, DEFAULT_MODEL_BUDGET)
  await assert.rejects(model.run({ ...request, onTextDelta: () => { throw new PublicTextPublicationError('delta', 'persistence_rejected', new Error(marker)) } }), error => {
    assert.ok(error instanceof ModelDriverError)
    assert.equal(error.diagnostics.kind, 'output'); assert.equal(error.diagnostics.outputCallback, 'delta')
    assert.equal(isPublicTextPublicationFailure(error), true)
    return true
  })
  assert.deepEqual({ calls, reserved, settled: observations.length }, { calls: 1, reserved: 1, settled: 1 })
  assert.deepEqual(observations[0]!.usage, { available: true, inputTokens: 7, outputTokens: 9 })
  assert.deepEqual(observations[0]!.failure, { category: 'unknown', retryable: false, kind: 'output', outputCallback: 'delta' })
  assert.equal(observations[0]!.status, 'failed'); assert.doesNotMatch(JSON.stringify(observations), /SYNTHETIC_PRIVATE/)
})

it('output origin does not alter existing protocol, network or publication recovery decisions', async () => {
  const errors = [new Error(marker), Object.assign(new Error(marker), { code: 'ECONNRESET' }),
    new DOMException(marker, 'TimeoutError'), new ModelDriverError(marker, { status: 401, finishReasons: [] }),
    new ModelDriverError(marker, { kind: 'protocol', protocolCode: 'public_text_invalid', finishReasons: [] }),
    new PublicTextSafetyError('policy_error'), new PublicTextPublicationError('operation', 'source_state')]
  for (const original of errors) {
    const before = modelFailure(original)
    await assert.rejects(driver().run({ ...request, onTextOperation: () => { throw original } }), error => {
      assert.ok(error instanceof ModelDriverError)
      const after = modelFailure(error)
      assert.equal(after.category, before.category); assert.equal(after.retryable, before.retryable)
      if (original instanceof ModelDriverError && original.diagnostics.kind === 'protocol') {
        assert.equal(error.diagnostics.kind, 'protocol'); assert.equal(error.diagnostics.protocolCode, original.diagnostics.protocolCode)
      }
      assert.doesNotMatch(JSON.stringify(publicModelDiagnostics(error.diagnostics)), /SYNTHETIC_PRIVATE/)
      return true
    })
  }
})

it('typed lifecycle/control-flow errors without usage retain their existing identity', async () => {
  for (const original of [new LeaseLostError(), new ModelBudgetExceededError('synthetic', 'calls')]) {
    await assert.rejects(driver(undefined, false).run({ ...request, onTextOperation: () => { throw original } }), error => error === original)
  }
})

it('callback diagnostic projection accepts only closed origin and stage values', () => {
  assert.deepEqual(publicModelDiagnostics({ kind: 'output', outputCallback: 'operation', category: 'unknown',
    finishReasons: [], message: marker, sourceId: marker }), { kind: 'output', outputCallback: 'operation', category: 'unknown', finishReasons: [] })
  assert.deepEqual(publicModelDiagnostics({ kind: marker, outputCallback: marker, cause: { message: marker } }), {})
  assert.deepEqual(publicModelDiagnostics({ get outputCallback() { throw new Error(marker) } }), {})
})

it('scopes callback attribution per invocation when concurrent callbacks reuse an error object', async () => {
  const shared = new Error(marker)
  const failures = await Promise.all([
    driver().run({ ...request, onTextOperation: async () => { await Promise.resolve(); throw shared } }).catch(error => error),
    driver().run({ ...request, onTextDelta: async () => { await Promise.resolve(); throw shared } }).catch(error => error),
  ])
  assert.deepEqual(failures.map(error => error.diagnostics.outputCallback), ['operation', 'delta'])
  const provider = new OpenAIChatDriver('synthetic-provider-reuse', { apiKey: 'synthetic', maxAttempts: 1,
    fetchImpl: async () => { throw shared } })
  await assert.rejects(provider.run(request), error => {
    assert.ok(error instanceof ModelDriverError)
    assert.notEqual(error.diagnostics.kind, 'output'); assert.equal(error.diagnostics.outputCallback, undefined)
    return true
  })
})

it('attributes operation rejection during final native identity validation', async () => {
  const prefix = { name: 'public_answer_extra', action: 'synthetic.read', effect: 'read' as const, approval: false,
    description: 'Synthetic prefix collision', parameters: { type: 'object' as const, properties: {}, additionalProperties: false as const } }
  await assert.rejects(driver().run({ ...request, tools: [prefix], onTextOperation: () => { throw new Error(marker) } }), error => {
    assert.ok(error instanceof ModelDriverError)
    assert.equal(error.diagnostics.kind, 'output'); assert.equal(error.diagnostics.outputCallback, 'operation')
    assert.deepEqual(error.diagnostics.usage, { available: true, inputTokens: 7, outputTokens: 9 })
    return true
  })
})
