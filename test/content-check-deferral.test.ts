// Failure inventory: docs/content-review-input-failure-model.md.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { it } from 'node:test'
import { snapshotEvidence } from '../src/context/evidence.js'
import type { RequestSnapshot } from '../src/context/request.js'
import type { ModelDriver, StructuredCallRequest } from '../src/model/driver.js'
import { checkCandidateContent } from '../src/outcome/content-check.js'

const body = 'The draft is ready. Publication awaits your confirmation.'
const request: RequestSnapshot = { version: 1, workId: 'w', tenantId: 't', sessionId: 's', authorId: 'human', sourceRef: 'message',
  originalText: 'Prepare a complete draft. Publish only after I confirm.', revisions: [], attachments: [], evidence: snapshotEvidence('e', []) }
const humanQuote = 'Publish only after I confirm.'
const current = { quote: 'Prepare a complete draft.', reason: 'The draft is incomplete.' }
const future = { quote: humanQuote, reason: 'Publication has not occurred.' }
const limitation = { quote: 'Publication awaits your confirmation.', requestQuote: humanQuote, reason: 'Publication is pending.' }
const proof = { id: 'limitation:0', quote: humanQuote, reason: 'The human reserved publication.' }
const publicLimitation = limitation
const unexpected = async (): Promise<never> => { throw new Error('unexpected model call') }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fixture(responses: unknown[]) {
  const calls: StructuredCallRequest[] = []
  const model: ModelDriver = { maxOutputTokens: 100, run: unexpected, compact: unexpected, structured: async input => {
    calls.push({ ...input, input: structuredClone(input.input) })
    assert.ok(calls.length <= responses.length, 'unexpected serial scope request')
    const value = responses[calls.length - 1]
    if (value instanceof Error) throw value
    return { value, model: 'fixture', usage: { available: true, inputTokens: 20, outputTokens: 5 } }
  } }
  return { model, calls }
}
const check = (model: ModelDriver, input = request, signal = new AbortController().signal) =>
  checkCandidateContent(model, input, body, [], 40000, signal)
const findings = (result: Awaited<ReturnType<typeof checkCandidateContent>>) => ({ missing: result.missing, limitations: result.limitations })

it('jointly checks delivery and human scope with one call, one usage and one exact input identity', async () => {
  const { model, calls } = fixture([{ missing: [], limitations: [limitation], deferred: [proof] }])
  const result = await check(model)
  assert.equal(calls.length, 1)
  assert.deepEqual(findings(result), { missing: [], limitations: [] })
  assert.equal('error' in result, false)
  assert.equal(result.inputSha256, hash(calls[0]!.input))
  assert.ok('deferralReview' in result)
  assert.deepEqual(result.deferralReview, { mode: 'combined', inputSha256: hash(calls[0]!.input),
    findings: [{ ...limitation, id: 'limitation:0' }], deferred: [proof] })
})

it('retains current and mixed findings, blockers and stable original indices', async () => {
  const blocked = { ...current, blockedBy: humanQuote }
  const mixed = { quote: request.originalText, reason: 'Current draft and future publication are missing.' }
  const { model, calls } = fixture([{ missing: [blocked, future, current, mixed],
    limitations: [{ ...limitation, requestQuote: null }, limitation],
    deferred: [{ ...proof, id: 'missing:1' }, { ...proof, id: 'limitation:1' }] }])
  const result = await check(model)
  assert.equal(calls.length, 1)
  assert.deepEqual(findings(result), { missing: [blocked, current, mixed], limitations: [] })
})

for (const deferred of [undefined, []]) it('keeps declared delivery limitations without proved exclusion and no fallback call', async () => {
  const { model, calls } = fixture([{ missing: [current], limitations: [limitation], ...(deferred ? { deferred } : {}) }])
  const result = await check(model)
  assert.equal(calls.length, 1)
  assert.equal('error' in result, false)
  assert.deepEqual(findings(result), { missing: [current], limitations: [publicLimitation] })
})

it('preserves complete evidence, ordered inherited/human/agent revisions and observations', async () => {
  const revised: RequestSnapshot = { ...request,
    inheritedRevisions: [{ id: 'inherited', text: 'Wait for confirmation.', createdAt: '1', author: { id: 'u', kind: 'human' } }],
    revisions: [{ id: 'agent', text: 'Publish immediately.', createdAt: '2', author: { id: 'a', kind: 'agent' } },
      { id: 'human', text: 'Keep publication pending until I confirm.', createdAt: '3', author: { id: 'u', kind: 'human' } }],
    attachments: [{ id: 'file', sourceVersion: '1', name: 'source.txt', mimeType: 'text/plain', size: 6, text: 'source' }] }
  const observations = { steps: [{ kind: 'teacher__draft_homework', output: { status: 'DRAFT' } }], conversation: 'x'.repeat(20000) }
  const before = structuredClone({ revised, observations })
  const { model, calls } = fixture([{ missing: [], limitations: [limitation], deferred: [{ ...proof, quote: revised.revisions[1]!.text }] }])
  const result = await checkCandidateContent(model, revised, body, [], 60000, new AbortController().signal, [], [], observations)
  assert.equal(calls.length, 1)
  const input = calls[0]!.input as { revisions: Array<{ id: string }>; observations: unknown; evidence: unknown }
  assert.deepEqual(input.revisions.map(item => item.id), ['inherited', 'agent', 'human'])
  assert.deepEqual(input.observations, observations)
  assert.deepEqual(input.evidence, revised.evidence)
  assert.deepEqual(findings(result), { missing: [], limitations: [] })
  assert.deepEqual({ revised, observations }, before)
})

for (const [label, deferred] of [
  ['null list', null], ['non-array list', 'none'], ['too many', Array.from({ length: 33 }, () => proof)],
  ['null entry', [null]], ['unknown ID', [{ ...proof, id: 'missing:99' }]], ['duplicate', [proof, proof]],
  ['non-string ID', [{ ...proof, id: 0 }]], ['extra key', [{ ...proof, extra: true }]],
  ['empty quote', [{ ...proof, quote: '' }]], ['blank quote', [{ ...proof, quote: ' ' }]],
  ['nonexact quote', [{ ...proof, quote: humanQuote + ' ' }]], ['long quote', [{ ...proof, quote: 'x'.repeat(2001) }]],
  ['invented quote', [{ ...proof, quote: 'Publication is cancelled.' }]], ['empty reason', [{ ...proof, reason: '' }]],
  ['blank reason', [{ ...proof, reason: ' \t ' }]], ['long reason', [{ ...proof, reason: 'x'.repeat(2001) }]],
] as const) it('retains every valid gap after invalid combined scope: ' + label, async () => {
  const { model, calls } = fixture([{ missing: [current], limitations: [limitation], deferred }])
  const result = await check(model)
  assert.equal(calls.length, 1)
  assert.equal('error' in result, true)
  assert.deepEqual(findings(result), { missing: [current], limitations: [publicLimitation] })
})

for (const blocked of [false, true]) it('rejects agent-only authority or removal of grounded blockers: ' + blocked, async () => {
  const text = 'Wait for the agent approval.'
  const revised: RequestSnapshot = { ...request, revisions: [{ id: 'a', text, createdAt: '1', author: { id: 'a', kind: 'agent' } }] }
  const missing = blocked ? { ...current, blockedBy: humanQuote } : current
  const { model, calls } = fixture([{ missing: [missing], limitations: [limitation],
    deferred: [{ ...proof, ...(blocked ? { id: 'missing:0' } : { quote: text }) }] }])
  const result = await check(model, revised)
  assert.equal(calls.length, 1)
  assert.equal('error' in result, true)
  assert.deepEqual(findings(result), { missing: [missing], limitations: [publicLimitation] })
})

it('permits one malformed-primary repair and no third scope request', async () => {
  const { model, calls } = fixture([{ missing: 'invalid' }, { missing: [], limitations: [limitation], deferred: [proof] }])
  const result = await check(model)
  assert.equal(calls.length, 2)
  assert.deepEqual(findings(result), { missing: [], limitations: [] })
  assert.equal(result.inputSha256, hash(calls[1]!.input))
})

it('propagates cancellation before processing joint scope decisions', async () => {
  const abort = new AbortController(), reason = new Error('human changed request')
  const { model, calls } = fixture([{ missing: [], limitations: [limitation], deferred: [proof] }])
  const structured = model.structured
  model.structured = async input => { const result = await structured(input); abort.abort(reason); return result }
  await assert.rejects(check(model, request, abort.signal), error => error === reason)
  assert.equal(calls.length, 1)
})
