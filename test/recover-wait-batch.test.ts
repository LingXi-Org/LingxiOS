import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { recoverWait } from '../src/app/recover-wait.js'
import { PgActionLedger, type SqlPool } from '../src/control-plane/pg-store.js'
import type { ControlPlaneService } from '../src/control-plane/service.js'
import type { SessionRecord, WorkItem } from '../src/protocol/types.js'
import { userInputWait } from '../src/protocol/input-wait.js'

it('bounds recovery per cell and checks terminal waits across the complete model batch', async () => {
  const db = new PGlite()
  const pool: SqlPool = { query: async (sql, args) => {
    const result = await db.query<Record<string, unknown>>(sql, args)
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
  }, connect: async () => ({ query: pool.query, release() {} }) }
  try {
    await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
    const ledger = new PgActionLedger(pool)
    for (const scenario of [
      { id: 'normal-101', counts: [50, 51], waitAt: -1, expected: undefined },
      { id: 'tail-200', counts: [100, 100], waitAt: 199, expected: 'awaiting_input' },
      { id: 'wait-before-next-cell', counts: [50, 51], waitAt: 49, expected: 'blocked' },
      { id: 'wait-after-old-page', counts: [100, 100], waitAt: 150, expected: 'blocked' },
      { id: 'single-overflow', counts: [101], waitAt: -1, expected: 'blocked' },
      { id: 'missing-receipt', counts: [50, 51], waitAt: 100, omitAt: 3, expected: undefined },
    ]) {
      const work: WorkItem = { id: scenario.id, tenantId: 't', agentId: 'a', sessionId: 's', principalId: 'u',
        kind: 'turn', lane: 'interactive', triggerRef: 'm', fence: 2, homeEpoch: 1, leaseToken: 'lease' }
      const history: SessionRecord['history'] = scenario.counts.map((_, index) => ({ type: 'function_call',
        callId: `cell-${index}`, name: 'ipython', arguments: '{}' }))
      const session = { history, request: { workId: work.id, revisions: [] } } as unknown as SessionRecord
      let ordinal = 0
      for (const [cell, count] of scenario.counts.entries()) {
        for (let callIndex = 0; callIndex < count; callIndex++, ordinal++) {
          const cellId = `cell-${cell}`, idempotencyKey = JSON.stringify([work.id, cellId, callIndex])
          const action = { runId: work.id, cellId, callIndex, idempotencyKey, action: 'chat.ask', args: {} }
          await ledger.reserve(idempotencyKey, idempotencyKey, { workId: work.id, tenantId: 't', agentId: 'a', sessionId: 's',
            principalId: 'u', threadId: null, requestVersion: 1, action })
          if (ordinal !== scenario.omitAt) await ledger.record(idempotencyKey, ordinal === scenario.waitAt
            ? userInputWait('Which city?') : { ok: true, executionState: 'succeeded', value: 'read complete' })
        }
      }
      let outcome: { status: string } | undefined
      const service = { getSession: async () => session, heartbeat: async () => ({ ok: true, steer: [] }),
        recordEvent: async () => {}, saveSession: async () => {},
        complete: async (_work: unknown, result: { goalOutcome: { status: string } }) => { outcome = result.goalOutcome },
        waitWork: async (_work: unknown, result: { status: string }) => { outcome = result },
      } as unknown as ControlPlaneService
      assert.equal(await recoverWait(pool, service, work), scenario.expected !== undefined, scenario.id)
      assert.equal(outcome?.status, scenario.expected, scenario.id)
      if (scenario.expected === 'awaiting_input') assert.equal(history.filter(item => 'type' in item && item.type === 'function_call_output').length, 2)
    }
  } finally { await db.close() }
})
