// Failure inventory: a false future-stage finding blocks completed current work; a current or mixed
// finding disappears without a proved human deferral; an agent quote, unknown or duplicate ID removes
// a real gap; malformed scope output clears valid findings; scope inputs mutate request/evidence or
// lose ordered revisions; follow-up calls exceed budget, ignore cancellation, or overwrite primary
// accounting. These tests exercise the contract; real-model cases check the semantic classification.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { it } from 'node:test'
import { snapshotEvidence } from '../src/context/evidence.js'
import type { RequestSnapshot } from '../src/context/request.js'
import type { ModelDriver, StructuredCallRequest } from '../src/model/driver.js'
import { checkCandidateContent } from '../src/outcome/content-check.js'

const body = 'The draft is ready. Publication awaits your confirmation.'
const request: RequestSnapshot = { version: 1, workId: 'deferral-work', tenantId: 'tenant', sessionId: 'session', authorId: 'human', sourceRef: 'message',
  originalText: 'Prepare a complete draft. Publish only after I confirm.', revisions: [], attachments: [], evidence: snapshotEvidence('evidence', []) }
const humanQuote = 'Publish only after I confirm.'
const currentMissing = { quote: 'Prepare a complete draft.', reason: 'The required draft is incomplete.' }
const futureMissing = { quote: humanQuote, reason: 'Publication has not occurred.' }
const futureLimitation = { quote: 'Publication awaits your confirmation.', requestQuote: humanQuote, reason: 'Publication is pending.' }
const deferred = { id: 'limitation:0', quote: humanQuote, reason: 'The human reserved publication for later confirmation.' }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const unexpected = async (): Promise<never> => { throw new Error('unexpected model call') }

function fixture(responses: unknown[]) {
  const calls: StructuredCallRequest[] = []
  const model: ModelDriver = { maxOutputTokens: 100, run: unexpected, compact: unexpected, structured: async input => {
    calls.push({ ...input, input: structuredClone(input.input) })
    assert.ok(calls.length <= responses.length, 'content check exceeded its bounded fixture')
    const value = responses[calls.length - 1]
    if (value instanceof Error) throw value
    return { value, model: `fixture-${calls.length}`, usage: { available: true, inputTokens: calls.length * 20, outputTokens: calls.length * 5 } }
  } }
  return { model, calls }
}

const check = (model: ModelDriver, input = request, text = body, signal = new AbortController().signal, limit = 32000) =>
  checkCandidateContent(model, input, text, [], limit, signal)
const findings = (result: Awaited<ReturnType<typeof checkCandidateContent>>) => ({ missing: result.missing, limitations: result.limitations })
const publicLimitation = { quote: futureLimitation.quote, reason: futureLimitation.reason }

it('removes only a proved future limitation and records separate scope identity and usage', async () => {
  const review = { missing: [], limitations: [futureLimitation] }
  const { model, calls } = fixture([review, { deferred: [deferred] }])
  const original = structuredClone({ request, review })
  const result = await check(model)
  assert.equal(calls.length, 2)
  assert.deepEqual(findings(result), { missing: [], limitations: [] })
  assert.equal('error' in result, false)
  assert.deepEqual(calls.map(call => call.purpose), ['content-review', 'content-review'])
  assert.notEqual(calls[0]!.instructions, calls[1]!.instructions)
  assert.notDeepEqual(calls[0]!.prompt, calls[1]!.prompt)
  const scoped = [{ id: 'limitation:0', ...futureLimitation }]
  assert.deepEqual(calls[1]!.input, { ...(calls[0]!.input as object), findings: scoped })
  assert.equal(result.inputSha256, hash(calls[0]!.input))
  assert.deepEqual((result as unknown as Record<string, unknown>)['deferralReview'], {
    inputSha256: hash(calls[1]!.input), findings: scoped, deferred: [deferred], model: 'fixture-2',
    usage: { available: true, inputTokens: 40, outputTokens: 10 },
  })
  assert.deepEqual({ model: 'model' in result && result.model, usage: 'usage' in result && result.usage },
    { model: 'fixture-1', usage: { available: true, inputTokens: 20, outputTokens: 5 } })
  assert.deepEqual({ request, review }, original)
})

it('maps missing and limitation IDs independently while preserving current findings', async () => {
  const review = { missing: [currentMissing, futureMissing], limitations: [futureLimitation] }
  const { model, calls } = fixture([review, { deferred: [{ ...deferred, id: 'missing:1' }, deferred] }])
  const result = await check(model)
  assert.equal(calls.length, 2)
  assert.deepEqual(findings(result), { missing: [currentMissing], limitations: [] })
  assert.deepEqual((calls[1]!.input as Record<string, unknown>)['findings'], [
    { id: 'missing:0', ...currentMissing }, { id: 'missing:1', ...futureMissing }, { id: 'limitation:0', ...futureLimitation },
  ])
})

it('preserves original valid gaps and blockers exactly when no finding is deferred', async () => {
  const blocked = { ...currentMissing, blockedBy: humanQuote }
  const review = { missing: [blocked], limitations: [futureLimitation] }
  const { model, calls } = fixture([review, { deferred: [] }])
  const before = structuredClone(review)
  const result = await check(model)
  assert.equal(calls.length, 2)
  assert.deepEqual(findings(result), { missing: [blocked], limitations: [publicLimitation] })
  assert.equal('error' in result, false)
  assert.deepEqual(review, before)
})

it('retains a mixed current/future finding as a whole when the scope review does not defer it', async () => {
  const mixed = { quote: request.originalText, reason: 'The current draft is missing and later publication has not occurred.' }
  const { model, calls } = fixture([{ missing: [mixed], limitations: [] }, { deferred: [] }])
  const result = await check(model)
  assert.equal(calls.length, 2)
  assert.deepEqual(findings(result), { missing: [mixed], limitations: [] })
})

for (const [label, review] of [
  ['no findings', { missing: [], limitations: [] }],
  ['only explanatory limitations', { missing: [], limitations: [{ ...futureLimitation, requestQuote: null }] }],
] as const) it(`makes no scope call for ${label}`, async () => {
  const { model, calls } = fixture([review])
  const result = await check(model)
  assert.equal(calls.length, 1)
  assert.deepEqual(findings(result), { missing: [], limitations: [] })
  assert.equal('deferralReview' in result, false)
})

it('passes complete evidence and ordered inherited/human/agent revisions without mutation', async () => {
  const revised: RequestSnapshot = { ...request,
    inheritedRevisions: [{ id: 'inherited', text: 'Wait until I approve publication.', createdAt: '1', author: { id: 'human', kind: 'human' } }],
    revisions: [{ id: 'agent', text: 'Publish immediately.', createdAt: '2', author: { id: 'agent', kind: 'agent' } },
      { id: 'human', text: 'Keep publication pending until I confirm.', createdAt: '3', author: { id: 'human', kind: 'human' } }],
    attachments: [{ id: 'attachment', sourceVersion: '1', name: 'source.txt', mimeType: 'text/plain', size: 6, text: 'source' }],
  }
  const proof = { ...deferred, quote: revised.revisions[1]!.text }
  const observations = { steps: [{ kind: 'teacher__draft_homework', output: { status: 'DRAFT' } }], dependencies: [] }
  const before = structuredClone({ revised, observations })
  const { model, calls } = fixture([{ missing: [], limitations: [futureLimitation] }, { deferred: [proof] }])
  const result = await checkCandidateContent(model, revised, body, [], 32000, new AbortController().signal, [], [], observations)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1]!.input, { ...(calls[0]!.input as object), findings: [{ id: 'limitation:0', ...futureLimitation }] })
  const input = calls[1]!.input as unknown as { revisions: Array<{ id: string }>; originalText: string; body: string }
  assert.deepEqual(input.revisions.map(item => item.id), ['inherited', 'agent', 'human'])
  assert.equal(input.originalText, request.originalText)
  assert.equal(input.body, body)
  assert.deepEqual(findings(result), { missing: [], limitations: [] })
  assert.deepEqual({ revised, observations }, before)
})

for (const [label, value] of [
  ['null response', null], ['array response', []], ['missing deferred list', {}], ['non-array deferred list', { deferred: 'none' }],
  ['extra top-level key', { deferred: [], unrelated: true }],
  ['extra entry key', { deferred: [{ ...deferred, unrelated: true }] }],
  ['more than 32 entries', { deferred: Array.from({ length: 33 }, () => deferred) }],
  ['null entry', { deferred: [null] }], ['unknown ID', { deferred: [{ ...deferred, id: 'missing:99' }] }],
  ['duplicate ID', { deferred: [deferred, deferred] }], ['non-string ID', { deferred: [{ ...deferred, id: 0 }] }],
  ['empty quote', { deferred: [{ ...deferred, quote: '' }] }],
  ['whitespace-only quote', { deferred: [{ ...deferred, quote: ' ' }] }],
  ['normalized but nonexact quote', { deferred: [{ ...deferred, quote: `  ${humanQuote}` }] }],
  ['oversized quote', { deferred: [{ ...deferred, quote: 'x'.repeat(2001) }] }],
  ['invented quote', { deferred: [{ ...deferred, quote: 'The human cancelled publication.' }] }],
  ['empty reason', { deferred: [{ ...deferred, reason: '' }] }],
  ['whitespace-only reason', { deferred: [{ ...deferred, reason: ' \t ' }] }],
  ['oversized reason', { deferred: [{ ...deferred, reason: 'x'.repeat(2001) }] }],
  ['transport failure', new Error('provider failed')], ['parsing failure', new SyntaxError('invalid JSON')],
] as const) it(`fails closed on scope ${label} without clearing valid findings or retrying`, async () => {
  const review = { missing: [currentMissing], limitations: [futureLimitation] }
  const { model, calls } = fixture([review, value])
  const result = await check(model)
  assert.equal(calls.length, 2)
  assert.equal('error' in result, true)
  assert.deepEqual(findings(result), { missing: [currentMissing], limitations: [publicLimitation] })
  assert.equal(result.inputSha256, hash(calls[0]!.input))
})

it('rejects an exact agent-only quote as authority to defer a human requirement', async () => {
  const agentQuote = 'Delay all work until next week.'
  const revised: RequestSnapshot = { ...request, revisions: [{ id: 'agent', text: agentQuote, createdAt: 'now', author: { id: 'agent', kind: 'agent' } }] }
  const { model, calls } = fixture([{ missing: [currentMissing], limitations: [] },
    { deferred: [{ id: 'missing:0', quote: agentQuote, reason: 'The agent deferred the work.' }] }])
  const result = await check(model, revised)
  assert.equal(calls.length, 2)
  assert.equal('error' in result, true)
  assert.deepEqual(findings(result), { missing: [currentMissing], limitations: [] })
})

it('uses at most three calls when primary repair is followed by one scope review', async () => {
  const review = { missing: [], limitations: [futureLimitation] }
  const { model, calls } = fixture([{ missing: 'invalid' }, review, { deferred: [deferred] }])
  const result = await check(model)
  assert.equal(calls.length, 3)
  assert.deepEqual(findings(result), { missing: [], limitations: [] })
  assert.equal(result.inputSha256, hash(calls[1]!.input))
  assert.deepEqual((calls[2]!.input as Record<string, unknown>)['findings'], [{ id: 'limitation:0', ...futureLimitation }])
})

it('propagates cancellation during the scope call instead of turning it into an inconclusive result', async () => {
  const abort = new AbortController(), reason = new Error('human request changed')
  const { model, calls } = fixture([{ missing: [], limitations: [futureLimitation] }, { deferred: [] }])
  const structured = model.structured
  model.structured = async input => { const value = await structured(input); if (calls.length === 2) abort.abort(reason); return value }
  await assert.rejects(check(model, request, body, abort.signal), error => error === reason)
  assert.equal(calls.length, 2)
})

it('checks the enlarged scope input budget before another call and retains valid gaps', async () => {
  const probe = fixture([{ missing: [], limitations: [] }])
  await check(probe.model)
  const first = probe.calls[0]!
  const contextLimit = Buffer.byteLength(first.instructions + JSON.stringify(first.input)) + 100 + 512
  const missing = Array.from({ length: 16 }, () => ({ ...currentMissing, reason: 'x'.repeat(2000) }))
  const { model, calls } = fixture([{ missing, limitations: [] }])
  const result = await check(model, request, body, new AbortController().signal, contextLimit)
  assert.equal(calls.length, 1)
  assert.equal('error' in result, true)
  assert.deepEqual(findings(result), { missing, limitations: [] })
})
