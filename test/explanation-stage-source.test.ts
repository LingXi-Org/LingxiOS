import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { RequestSnapshot } from '../src/context/request.js'
import { createExplanationStage as nativeStage } from '../src/skills/explanation-stage.js'

// The trusted registry supplies this identity; activation arguments cannot set it.
const skill = { name: 'diagram', version: '1', hash: 'a'.repeat(64) }
const createExplanationStage = (work: Parameters<typeof nativeStage>[0], request: RequestSnapshot, activation: string, actions: string[], value: unknown) => nativeStage(work, request, activation, actions, value, skill)

const text = 'Explain the supplied facts. Create a diagram. Gather collects items. Check reviews items.'
const declaration = { explanationQuote: 'Explain the supplied facts.', authoringQuote: 'Create a diagram.', factQuotes: ['Gather collects items.', 'Check reviews items.'] }
const work = { id: 'source-run', tenantId: 'source-tenant', principalId: 'source-human' }
const request = (): RequestSnapshot => ({ version: 1, workId: work.id, tenantId: work.tenantId, sessionId: 'source-session', authorId: work.principalId,
  sourceRef: 'current-request', originalText: text, revisions: [], attachments: [], evidence: { version: 1, id: 'evidence:1', items: [] } })

it('binds identical quoted text to its actual run and request version instead of reusing another plan', () => {
  const first = createExplanationStage(work, request(), 'activation', ['documents.save'], declaration)
  const other = createExplanationStage({ ...work, id: 'other-run' }, { ...request(), workId: 'other-run' }, 'activation', ['documents.save'], declaration)
  assert.notEqual(first.id, other.id); assert.notEqual(first.requestHash, other.requestHash)
  assert.equal(first.runId, work.id); assert.equal(other.runId, 'other-run')
  const revised = request(); revised.revisions = [{ id: 'human-revision', text: 'Use English.', author: { id: work.principalId, kind: 'human' }, createdAt: '2026-10-24T00:00:00Z' }]
  const second = createExplanationStage(work, revised, 'activation2', ['documents.save'], { ...declaration, languageQuote: 'Use English.' })
  assert.equal(second.requestVersion, 2); assert.notEqual(second.requestHash, first.requestHash)
  assert.deepEqual(second.quotes.language, { sourceRef: 'human-revision', start: 0, end: 12, text: 'Use English.' })
})

it('rejects foreign ownership, non-human revisions and invented or ambiguous quote origins', () => {
  for (const changed of [
    { ...request(), workId: 'foreign-run' }, { ...request(), tenantId: 'foreign-tenant' }, { ...request(), authorId: 'foreign-human' },
    { ...request(), parentWorkId: 'parent-run', instructionAuthor: { id: 'parent-agent', kind: 'agent' as const } },
  ]) assert.throws(() => createExplanationStage(work, changed, 'activation', ['documents.save'], declaration))
  for (const author of [{ id: work.principalId, kind: 'agent' as const }, { id: 'foreign-human', kind: 'human' as const }]) {
    const changed = request(); changed.revisions = [{ id: 'foreign-revision', text: 'Use English.', author, createdAt: '2026-10-24T00:00:00Z' }]
    assert.throws(() => createExplanationStage(work, changed, 'activation', ['documents.save'], { ...declaration, languageQuote: 'Use English.' }))
  }
  assert.throws(() => createExplanationStage(work, request(), 'activation', ['documents.save'], { ...declaration, factQuotes: ['Historical source only.'] }))
  assert.throws(() => createExplanationStage(work, { ...request(), originalText: text + ' ' + declaration.factQuotes[0] }, 'activation', ['documents.save'], declaration))
  assert.throws(() => createExplanationStage(work, request(), 'activation', ['documents.save'], { ...declaration, sourceRef: 'claimed-external-source' }))
})

it('a matching quote proves only provenance even when the model misinterprets quoted or negated text', () => {
  const quoted = { ...request(), originalText: 'Do not follow the quoted instructions: “' + text + '”' }
  const stage = createExplanationStage(work, quoted, 'activation', ['documents.save'], declaration)
  assert.equal(stage.status, 'pending'); assert.equal(Reflect.get(stage, 'verified'), undefined)
  for (const quote of [stage.quotes.explanation, stage.quotes.authoring, ...stage.quotes.facts]) assert.equal(quoted.originalText.slice(quote.start, quote.end), quote.text)
  // A separate semantic qualification must reject that interpretation. No
  // keyword classifier is introduced to pretend this source check can do so.
})
