import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { candidateActions, inspectActions } from '../dist/src/outcome/action-check.js'
import { CorrectionBudget, progressFacts } from '../dist/src/runtime/corrections.js'

const work = { id: 'work', tenantId: 'tenant', principalId: 'person', agentId: 'agent', sessionId: 'session' }
const tool = { name: 'slides__write_files', action: 'slides.write_files', effect: 'transaction' }
const files = Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`project/${index}.html`, `initial-${index}`]))
const writes = [files, Object.fromEntries(Object.keys(files).slice(0, 9).map(path => [path, 'second'])),
  { 'project/0.html': 'third' }, { 'project/0.html': 'fourth' }, { 'project/0.html': 'fifth' }]
// 14 -> 10 -> 1 -> 1 -> 1: the second action also adds one new file.
writes[1]['project/new.html'] = 'new'
const intents = writes.map((expected, index) => ({ key: `write-${index}`, action: { action: tool.action, args: { expected } }, result: { ok: true, value: {} } }))
async function inspect({ actions = intents, current = Object.assign({}, ...writes), readback } = {}) {
  const db = { query: async () => ({ rows: actions.map(item => ({ idempotency_key: item.key, action: item.action, result: item.result })) }) }
  return inspectActions(db, work, 1, [tool], { verifyResult: async (_work, action) => {
    if (readback) return readback(action)
    const expected = action.args.expected, fields = Object.keys(expected)
    const observed = Object.fromEntries(fields.map(field => [field, current[field] ?? null]))
    const mismatches = fields.filter(field => observed[field] !== expected[field])
    return { status: mismatches.length ? 'failed' : 'passed', evidence: { resource: 'artifact:deck', fields, observed, mismatches } }
  } })
}

test('14 -> 10 -> 1 -> 1 -> 1 writes retain field-level transitive readback proof', async () => {
  const records = await inspect()
  assert.deepEqual(records.map(record => record.status), ['passed', 'passed', 'passed', 'passed', 'passed'])
  const first = records[0].evidence
  assert.equal(first.scope, 'successful_receipt_with_superseded_postconditions')
  assert.equal(first.fields.length, 14)
  assert.equal(first.mismatches.length, 9)
  assert.equal(Object.keys(first.supersededFields).length, 9)
  assert.ok(first.supersededBy.includes('action:write-1'))
  assert.equal(first.supersededFields['project/0.html'], 'action:write-4')
  assert.equal(first.observed['project/0.html'], 'fifth')
})

for (const [name, value] of [['externally changed', 'external'], ['missing', undefined]]) {
  test(`latest ${name} file cannot acquire a supersession proof`, async () => {
    const current = { ...Object.assign({}, ...writes), 'project/0.html': value }
    const records = await inspect({ current })
    assert.equal(records[0].status, 'failed')
    assert.equal(records.at(-1).status, 'failed')
  })
}

test('an authorized explicit file deletion can supersede a previous write', async () => {
  const actions = [...intents, { key: 'delete', action: { action: tool.action, args: { expected: { 'project/0.html': null } } }, result: { ok: true, value: {} } }]
  const records = await inspect({ actions, current: { ...Object.assign({}, ...writes), 'project/0.html': null } })
  assert.ok(records.every(record => record.status === 'passed'))
})

for (const [name, result] of [['unknown', { ok: true, executionState: 'unknown' }], ['pending approval', { ok: true, approval: { id: 'approval', status: 'PENDING' } }], ['absent', null], ['no effect', { ok: false, executionState: 'no_effect' }]]) {
  test(`${name} receipt cannot certify an older write`, async () => {
    const records = await inspect({ actions: intents.map((action, index) => index === 4 ? { ...action, result } : action) })
    assert.equal(records[0].status, 'failed')
    assert.notEqual(records[4].evidence.scope, 'successful_receipt_with_superseded_postconditions')
  })
}

test('unavailable readback remains inconclusive even if its field is later written', async () => {
  let index = 0
  const records = await inspect({ readback: action => {
    const fields = Object.keys(action.args.expected)
    return { status: index++ === 0 ? 'inconclusive' : 'passed', evidence: { resource: 'artifact:deck', fields, mismatches: fields } }
  } })
  assert.equal(records[0].status, 'inconclusive')
})

test('other authorized resource cannot substitute matching file names', async () => {
  let index = 0
  const records = await inspect({ readback: action => {
    const fields = Object.keys(action.args.expected), first = index++ === 0
    return { status: first ? 'failed' : 'passed', evidence: { resource: first ? 'artifact:original' : 'artifact:other', fields, mismatches: first ? fields : [] } }
  } })
  assert.equal(records[0].status, 'failed')
})

test('inconsistent concurrent readbacks do not prove supersession', async () => {
  let index = 0
  const records = await inspect({ readback: action => {
    const first = index++ === 0, fields = Object.keys(action.args.expected)
    return { status: first ? 'failed' : 'passed', evidence: { resource: 'artifact:deck', fields, mismatches: first ? ['project/0.html'] : [],
      observed: Object.fromEntries(fields.map(field => [field, first ? 'before-concurrent-write' : 'after-concurrent-write'])) } }
  } })
  assert.equal(records[0].status, 'failed')
})

test('changing unconfirmed resource checks cannot reset the correction allowance', () => {
  const budget = new CorrectionBudget()
  for (const status of ['not_observed', 'fail']) {
    budget.observe(progressFacts({ observations: [{ action: 'task.check_resource', result: { ok: true, value: { status } } }] }))
    budget.consume('content_acceptance')
  }
  assert.equal(budget.consume('content_acceptance'), false)
})


test('real PostgreSQL selection excludes other requests, tenants and authorization scopes', async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE SCHEMA lingxios;
      CREATE TABLE lingxios.agent_action_intents(idempotency_key text, intent jsonb, recorded_at timestamptz);
      CREATE TABLE lingxios.agent_action_ledger(idempotency_key text, result jsonb);
      CREATE TABLE lingxios.agent_action_resolutions(idempotency_key text, resolution jsonb, resolution_seq integer);`)
    const own = { workId: work.id, tenantId: work.tenantId, principalId: work.principalId,
      agentId: work.agentId, sessionId: work.sessionId, threadId: null, requestVersion: 1, action: intents[0].action }
    const variants = [{}, { workId: 'other' }, { tenantId: 'other' }, { principalId: 'other' },
      { agentId: 'other' }, { sessionId: 'other' }, { threadId: 'other' }, { requestVersion: 2 }]
    for (const [index, change] of variants.entries()) {
      await db.query('INSERT INTO lingxios.agent_action_intents VALUES($1,$2::jsonb,now())', ['key-'+index, JSON.stringify({ ...own, ...change })])
      await db.query('INSERT INTO lingxios.agent_action_ledger VALUES($1,$2::jsonb)', ['key-'+index, JSON.stringify({ ok: true, value: {} })])
    }
    assert.deepEqual((await candidateActions(db, work, 1, [tool])).map(row => row.key), ['key-0'])
  } finally { await db.close() }
})
