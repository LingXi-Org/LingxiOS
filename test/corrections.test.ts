import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CorrectionBudget } from '../src/runtime/corrections.js'

test('reworded errors and timestamps do not reset the bound; new resource versions do', () => {
  const budget = new CorrectionBudget()
  for (let n = 1; n <= 3; n++) {
    assert.equal(budget.consume('kernel_error', 'same operation: missing file'), n < 3)
    assert.equal(budget.rediagnose, n >= 2)
  }
  assert.equal(budget.consume('kernel_error', 'different wording: denied at a new timestamp'), false)
  budget.observe('new result')
  assert.equal(budget.consume('kernel_error', 'same operation: missing file'), true)
  budget.observe('new result') // Repeating the observation does not manufacture progress.
  for (let n = 2; n <= 3; n++) assert.equal(budget.consume('kernel_error', 'same operation: missing file'), n < 3)
  budget.observe({ observedAt: '2026-01-01T00:00:00Z', resource: 'document:1', revision: 'v1' })
  budget.consume('kernel_error', 'failed')
  budget.observe({ observedAt: '2026-01-02T00:00:00Z', resource: 'document:1', revision: 'v1' })
  assert.equal(budget.snapshot().count, 1)
  budget.observe({ resource: 'document:1', revision: 'v2' })
  assert.equal(budget.snapshot().count, 0)
})
// Failure inventory: docs/evidence/content-correction-allowance/FAILURE-MODEL.md.
test('additional content corrections preserve protocol/kernel limits and spent checkpoints', () => {
  for (const extra of [0,1,2,3]) {
    let budget = new CorrectionBudget(undefined,extra)
    assert.equal(budget.consume('tool_protocol'),true)
    assert.equal(budget.consume('response_protocol'),true)
    for (let n = 0; n <= extra; n++) {
      budget = new CorrectionBudget(budget.snapshot(),extra)
      assert.equal(budget.has('content_acceptance'),n < extra)
      assert.equal(budget.consume('content_acceptance'),n < extra)
      assert.ok(budget.snapshot().count <= 6)
    }
    budget.observe({ revision: 'new' })
    assert.equal(budget.consume('tool_protocol'),false,'new progress cannot refill lifetime protocol repairs')
    assert.equal(budget.consume('kernel_error'),true)
    assert.equal(budget.consume('kernel_error'),true)
    assert.equal(budget.has('kernel_error'),false)
    assert.equal(budget.consume('kernel_error'),false,'content configuration cannot add tool retries')
  }
})
