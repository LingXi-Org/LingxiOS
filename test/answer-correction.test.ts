import assert from 'node:assert/strict'
import { it } from 'node:test'
import { ModelDriverError } from '../src/errors.js'
import { answerCorrectionOperation, assertAnswerCorrection, restoreAnswerCorrection } from '../src/runtime/answer-correction.js'

it('only an explicit runtime correction with active sealed sources requires replacement', () => {
  assert.equal(answerCorrectionOperation(false, ['source-a']), undefined)
  assert.equal(answerCorrectionOperation(true, []), undefined)
  const sources = ['source-a', 'source-b']
  const required = answerCorrectionOperation(true, sources)
  assert.deepEqual(required, { kind: 'replace', supersedes: sources })
  sources.push('later-source')
  assert.deepEqual(required?.supersedes, ['source-a', 'source-b'], 'freeze the candidate being repaired')
  assert.doesNotThrow(() => assertAnswerCorrection({ kind: 'append', supersedes: [] }, undefined))
})

it('repair intent restores only for its exact request and still-active sources', () => {
  const operation = { kind: 'replace', supersedes: ['source-a'] }
  const step = { id: 'repair', kind: 'runtime.answer_correction', requestVersion: 2, input: { operation }, output: '{}', artifacts: [] }
  assert.deepEqual(restoreAnswerCorrection([step], 2, ['source-a']), operation)
  assert.equal(restoreAnswerCorrection([step], 3, ['source-a']), undefined)
  assert.equal(restoreAnswerCorrection([step], 2, ['corrected-source']), undefined)
  assert.equal(restoreAnswerCorrection([], 2, ['source-a']), undefined)
})

it('a repair cannot append, partially replace, reorder or guess its candidate sources', () => {
  const required = answerCorrectionOperation(true, ['source-a', 'source-b'])
  for (const actual of [undefined, { kind: 'append' as const, supersedes: [] },
    { kind: 'replace' as const, supersedes: ['source-a'] }, { kind: 'replace' as const, supersedes: ['source-b', 'source-a'] },
    { kind: 'replace' as const, supersedes: ['unknown-source', 'source-b'] }]) {
    assert.throws(() => assertAnswerCorrection(actual, required), error => error instanceof ModelDriverError
      && error.diagnostics.kind === 'protocol' && error.diagnostics.protocolCode === 'public_text_invalid')
  }
  assert.doesNotThrow(() => assertAnswerCorrection({ kind: 'replace', supersedes: ['source-a', 'source-b'] }, required))
})
