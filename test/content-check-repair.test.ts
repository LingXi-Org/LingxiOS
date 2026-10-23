// Failure inventory: valid reviews must cost one call; malformed returned values and ungrounded quotes
// may receive only one repair for the same request/candidate, with field/constraint feedback only.
// Repeated invalidity stays inconclusive; transport/parsing exceptions are not blindly retried;
// aborts and context budgets stop paid calls; human blockers and request quotes remain exact.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { it } from 'node:test'
import { snapshotEvidence } from '../src/context/evidence.js'
import type { RequestSnapshot } from '../src/context/request.js'
import type { ModelDriver, StructuredCallRequest } from '../src/model/driver.js'
import { checkCandidateContent } from '../src/outcome/content-check.js'

const usage = { available: true, inputTokens: 80, outputTokens: 20 }
const valid = { missing: [], limitations: [] }
const body = 'The draft is ready. Publication awaits your confirmation.'
const request: RequestSnapshot = { version: 1, workId: 'review-work', tenantId: 'tenant', sessionId: 'session', authorId: 'teacher', sourceRef: 'message',
  originalText: 'Prepare a draft. Do not publish without my confirmation.', revisions: [], attachments: [], evidence: snapshotEvidence('evidence', []) }
const invalidQuote = { missing: [], limitations: [{ quote: 'PRIVATE_UNGROUNDED_QUOTE', requestQuote: 'Prepare a draft.', reason: 'PRIVATE_REVIEW_REASON' }] }
const errorMessage = 'Content check was unavailable or returned invalid findings'
const unexpected = async (): Promise<never> => { throw new Error('unexpected model method') }

// Irrelevant evidence can exceed a reviewer window even after execution projects
// it on demand. Preserve exact cited excerpts and report omitted source count.
it('reviews cited originals within budget when unrelated evidence is large', async () => {
  const evidence = snapshotEvidence('large', Array.from({ length: 200 }, (_, index) => ({ marker: `S${index + 1}`,
    sourceId: `source-${index}`, sourceVersion: 'v1', chunkId: `chunk-${index}`, title: `Source ${index}`,
    excerpt: index === 0 ? 'The correct number is 47.' : 'Unrelated source content. '.repeat(1000) })))
  let called = false
  const model: ModelDriver = { maxOutputTokens: 100, run: unexpected, compact: unexpected, structured: async call => {
    called = true
    const input = call.input as { evidence: typeof evidence; omittedEvidenceItems: number }
    assert.deepEqual(input.evidence.items, [evidence.items[0]])
    assert.equal(input.omittedEvidenceItems, 199)
    return { value: valid, model: 'test', usage }
  } }
  const result = await checkCandidateContent(model, { ...request, originalText: 'What is the number?', evidence },
    '[47](#cite-S1)', [], 32000, new AbortController().signal)
  assert.equal(called, true)
  assert.equal('error' in result, false)
})

function fixture(responses: unknown[]) {
  const calls: StructuredCallRequest[] = [], metered: typeof usage[] = []
  const model: ModelDriver = { maxOutputTokens: 100, run: unexpected, compact: unexpected, structured: async input => {
    calls.push({ ...input, input: structuredClone(input.input) })
    assert.ok(calls.length <= responses.length, 'review exceeded its bounded response fixture')
    const value = responses[calls.length - 1]
    if (value instanceof Error) throw value
    metered.push(usage)
    return { value, model: 'review-fixture', usage }
  } }
  return { model, calls, metered }
}

it('accepts a valid first review with one call and its actual input identity', async () => {
  const { model, calls } = fixture([valid])
  const result = await checkCandidateContent(model, request, body, [], 32000, new AbortController().signal)
  assert.equal(calls.length, 1)
  assert.equal(Object.hasOwn(calls[0]!.input as object, 'validationFailures'), false)
  assert.equal('error' in result, false)
  assert.deepEqual({ missing: result.missing, limitations: result.limitations, usage: 'usage' in result && result.usage }, { ...valid, usage })
  assert.equal(result.inputSha256, createHash('sha256').update(JSON.stringify(calls[0]!.input)).digest('hex'))
})

for (const [label, value, failure] of [
  ['malformed returned JSON value', '{not parsed JSON', { path: '$', constraint: 'object' }],
  ['wrong missing shape', { missing: 'none' }, { path: 'missing', constraint: 'array_max_16' }],
  ['ungrounded limitation quote', invalidQuote, { path: 'limitations[0].quote', constraint: 'exact_body_quote' }],
] as const) it(`repairs ${label} once without changing the candidate or exposing the invalid reply`, async () => {
  const { model, calls, metered } = fixture([value, valid])
  const before = structuredClone(request)
  const result = await checkCandidateContent(model, request, body, [], 32000, new AbortController().signal)
  assert.equal(calls.length, 2)
  assert.equal('error' in result, false)
  assert.deepEqual({ missing: result.missing, limitations: result.limitations }, valid)
  assert.deepEqual(metered, [usage, usage])
  assert.deepEqual(request, before)
  const second = calls[1]!.input as Record<string, unknown>
  const { validationFailures, ...sameInput } = second
  assert.deepEqual(sameInput, calls[0]!.input)
  assert.deepEqual(validationFailures, [failure])
  assert.doesNotMatch(JSON.stringify(validationFailures), /PRIVATE_|not parsed JSON/)
  assert.deepEqual({ instructions: calls[1]!.instructions, prompt: calls[1]!.prompt }, { instructions: calls[0]!.instructions, prompt: calls[0]!.prompt })
  assert.equal(result.inputSha256, createHash('sha256').update(JSON.stringify(second)).digest('hex'))
})

it('keeps the existing inconclusive error after two invalid reviews', async () => {
  const { model, calls } = fixture([invalidQuote, invalidQuote, valid])
  const result = await checkCandidateContent(model, request, body, [], 32000, new AbortController().signal)
  assert.equal(calls.length, 2)
  assert.deepEqual({ missing: result.missing, limitations: result.limitations, error: 'error' in result && result.error },
    { ...valid, error: errorMessage })
})

for (const error of [new Error('provider unavailable'), new SyntaxError('provider returned invalid JSON')]) {
  it(`does not retry a structured driver exception: ${error.name}`, async () => {
    const { model, calls } = fixture([error, valid])
    const result = await checkCandidateContent(model, request, body, [], 32000, new AbortController().signal)
    assert.equal(calls.length, 1)
    assert.equal('error' in result && result.error, errorMessage)
  })
}

it('propagates an already aborted review without making a model call', async () => {
  const { model, calls } = fixture([valid])
  const abort = new AbortController(), reason = new Error('review cancelled')
  abort.abort(reason)
  await assert.rejects(checkCandidateContent(model, request, body, [], 32000, abort.signal), error => error === reason)
  assert.equal(calls.length, 0)
})

it('propagates cancellation after the first response before attempting a repair', async () => {
  const { model, calls } = fixture([invalidQuote, valid])
  const abort = new AbortController(), reason = new Error('request changed')
  const structured = model.structured
  model.structured = async input => { const result = await structured(input); abort.abort(reason); return result }
  await assert.rejects(checkCandidateContent(model, request, body, [], 32000, abort.signal), error => error === reason)
  assert.equal(calls.length, 1)
})

for (const [label, value, failure] of [
  ['agent-only blocker', { missing: [{ quote: 'Prepare a draft.', reason: 'Blocked.', blockedBy: 'Do not prepare the draft.' }], limitations: [] },
    { path: 'missing[0].blockedBy', constraint: 'exact_human_quote' }],
  ['invented request quote', { missing: [], limitations: [{ quote: 'Publication awaits your confirmation.', reason: 'Pending.', requestQuote: 'Publish the completed draft now.' }] },
    { path: 'limitations[0].requestQuote', constraint: 'exact_request_quote_or_null' }],
] as const) it(`does not accept a ${label} after repair`, async () => {
  const { model, calls } = fixture([value, value])
  const revised: RequestSnapshot = { ...request, revisions: [{ id: 'agent-revision', text: 'Do not prepare the draft.', createdAt: 'now', author: { id: 'assistant', kind: 'agent' } }] }
  const result = await checkCandidateContent(model, revised, body, [], 32000, new AbortController().signal)
  assert.equal(calls.length, 2)
  assert.deepEqual((calls[1]!.input as Record<string, unknown>)['validationFailures'], [failure])
  assert.equal('error' in result && result.error, errorMessage)
  assert.deepEqual({ missing: result.missing, limitations: result.limitations }, valid)
})

it('preserves grounded blockers and explanatory null request quotes without a scope review', async () => {
  const value = { missing: [{ quote: 'Prepare a draft.', reason: 'Still incomplete.', blockedBy: 'Do not publish without my confirmation.' }],
    limitations: [{ quote: 'Publication awaits your confirmation.', requestQuote: null, reason: 'Future publication needs confirmation.' }] }
  const { model, calls } = fixture([value])
  const result = await checkCandidateContent(model, request, body, [], 32000, new AbortController().signal)
  assert.equal(calls.length, 1)
  assert.deepEqual({ missing: result.missing, limitations: result.limitations }, { missing: value.missing, limitations: [] })
})

// Excluded explanatory remarks are not findings; paraphrasing them must not
// invalidate current grounded gaps, while actual findings still require exact quotes.
it('discards a paraphrased explanatory remark without losing a grounded current blocker', async () => {
  const missing = [{ quote: 'Prepare a draft.', reason: 'Still incomplete.', blockedBy: 'Do not publish without my confirmation.' }]
  const { model, calls } = fixture([{ missing, limitations: [{ quote: 'Publication is reserved for a later confirmation.',
    requestQuote: null, reason: 'No currently due result is missing.' }] }])
  const result = await checkCandidateContent(model, request, body, [], 32000, new AbortController().signal)
  assert.equal(calls.length, 1)
  assert.equal('error' in result, false)
  assert.deepEqual({ missing: result.missing, limitations: result.limitations }, { missing, limitations: [] })
})

it('still rejects an ungrounded current finding alongside a paraphrased explanatory remark', async () => {
  const value = { missing: [], limitations: [{ quote: 'Publication is reserved for a later confirmation.',
    requestQuote: null, reason: 'No currently due result is missing.' }, ...invalidQuote.limitations] }
  const { model, calls } = fixture([value, value])
  const result = await checkCandidateContent(model, request, body, [], 32000, new AbortController().signal)
  assert.equal(calls.length, 2)
  assert.equal('error' in result && result.error, errorMessage)
  assert.deepEqual((calls[1]!.input as Record<string, unknown>)['validationFailures'],
    [{ path: 'limitations[1].quote', constraint: 'exact_body_quote' }])
})

it('checks the repaired input against the context budget before making another paid call', async () => {
  const probe = fixture([valid])
  await checkCandidateContent(probe.model, request, body, [], 32000, new AbortController().signal)
  const first = probe.calls[0]!
  const contextLimit = Buffer.byteLength(first.instructions + JSON.stringify(first.input)) + 100 + 512
  const { model, calls } = fixture([invalidQuote, valid])
  const result = await checkCandidateContent(model, request, body, [], contextLimit, new AbortController().signal)
  assert.equal(calls.length, 1)
  assert.equal('error' in result && result.error, 'Content check input exceeds the model context budget')
})


it('retains the exact request association and human blocker for a declared limitation', async () => {
  const limitation = { quote: 'Publication awaits your confirmation.',requestQuote: 'Prepare a draft.',reason: 'The draft is unavailable.',
    blockedBy: 'Do not publish without my confirmation.' }
  const { model } = fixture([{ missing: [],limitations: [limitation] }])
  const result = await checkCandidateContent(model,request,body,[],32000,new AbortController().signal)
  assert.deepEqual(result.limitations,[limitation])
})

it('rejects invalid priority rather than silently downgrading a required finding', async () => {
  const invalid = { missing: [{ quote: 'Prepare a draft.',reason: 'Draft missing.',priority: 'cosmetic' }],limitations: [] }
  const { model,calls } = fixture([invalid,valid])
  const result = await checkCandidateContent(model,request,body,[],32000,new AbortController().signal)
  assert.equal(calls.length,2)
  assert.deepEqual((calls[1]!.input as Record<string,unknown>)['validationFailures'],[{ path: 'missing[0].priority',constraint: 'required_or_optional' }])
  assert.deepEqual(result.missing,[])
})
