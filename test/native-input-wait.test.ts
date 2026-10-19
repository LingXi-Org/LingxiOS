import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { MemoryActionLedger } from '../src/control-plane/memory-store.js'
import { PgActionLedger, type SqlPool } from '../src/control-plane/pg-store.js'
import type { HostActionResult } from '../src/protocol/types.js'
import { userInputWait } from '../src/index.js'

it('exports a typed user input wait with bounded question and optional product value', () => {
  assert.deepEqual(userInputWait('Choose a city', { cardId: 'card' }), { ok: true, executionState: 'succeeded',
    value: { cardId: 'card' }, directive: { type: 'defer', reason: 'user', data: { question: 'Choose a city' } } })
  for (const question of ['', ' \n ', 'x'.repeat(4001)]) assert.throws(() => userInputWait(question), /input question/)
})

for (const backend of ['memory', 'postgres'] as const) it(`${backend} requires a current successful durable input receipt, not an action name`, async () => {
  const db = backend === 'postgres' ? new PGlite() : undefined
  const pool: SqlPool = { query: async (sql, params) => { const result = await db!.query<Record<string, unknown>>(sql, params)
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length } }, connect: async () => ({ query: pool.query, release() {} }) }
  if (db) await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  const ledger = db ? new PgActionLedger(pool) : new MemoryActionLedger()
  try {
    const question = 'Choose a city'
    const receipt = userInputWait(question)
    const cases: Array<[string, HostActionResult, boolean]> = [
      ['valid', receipt, true],
      ['forged-ok', { ...receipt, ok: 'true' } as unknown as HostActionResult, false],
      ['null-state', { ...receipt, executionState: null } as unknown as HostActionResult, false],
      ['null-approval', { ...receipt, approval: null } as unknown as HostActionResult, false], ['legacy', { ok: true, directive: receipt.directive }, true],
      ['failed', { ...receipt, ok: false }, false], ['unknown', { ...receipt, executionState: 'unknown' }, false],
      ['rejected', { ...receipt, executionState: 'rejected' }, false], ['no-effect', { ...receipt, executionState: 'no_effect' }, false],
      ['approval', { ...receipt, approval: { id: 'approval', status: 'PENDING' } }, false],
      ['child', { ok: true, directive: { type: 'defer', reason: 'child', data: { question } } }, false],
      ['no-defer', { ok: true, value: { question } }, false],
      ['missing-question', { ok: true, directive: { type: 'defer', reason: 'user' } }, false],
    ]
    for (const [id, result, allowed] of cases) {
      const action = { runId: id, cellId: 'cell', callIndex: 0, action: 'chat.ask', args: { form: 'city' }, idempotencyKey: id }
      await ledger.reserve(id, id, { workId: id, tenantId: 't', principalId: 'u', agentId: 'a', sessionId: id, threadId: null, requestVersion: 2, action })
      assert.equal(await ledger.hasWait(id, 2, { question }), false, `${id}: intent alone cannot wait`)
      await ledger.record(id, result)
      assert.equal(await ledger.hasWait(id, 2, { question }), allowed, id)
      assert.equal(await ledger.hasWait(id, 1, { question }), false, `${id}: stale version`)
      assert.equal(await ledger.hasWait('other', 2, { question }), false, `${id}: different work`)
      assert.equal(await ledger.hasWait(id, 2, { question: 'forged' }), false, `${id}: forged question`)
    }
    for (const question of ['', ' \n ', 'x'.repeat(4001)]) {
      const action = { runId: question, cellId: 'cell', callIndex: 0, action: 'chat.ask', args: {}, idempotencyKey: `invalid:${question}` }
      await ledger.reserve(action.idempotencyKey, 'invalid', { workId: 'invalid', tenantId: 't', principalId: 'u', agentId: 'a', sessionId: 's', threadId: null, requestVersion: 1, action })
      await ledger.record(action.idempotencyKey, { ok: true, directive: { type: 'defer', reason: 'user', data: { question } } })
      assert.equal(await ledger.hasWait('invalid', 1, { question }), false)
    }
  } finally { await db?.close() }
})
