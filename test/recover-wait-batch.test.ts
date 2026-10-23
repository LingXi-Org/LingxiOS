import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { recoverWait } from '../src/app/recover-wait.js'
import { PgStepStore } from '../src/control-plane/steps.js'
import { PgActionLedger, type SqlPool } from '../src/control-plane/pg-store.js'
import type { ControlPlaneService } from '../src/control-plane/service.js'
import type { SessionRecord, WorkItem } from '../src/protocol/types.js'
import { TASK_TOOLS } from '../src/tools/catalog.js'
import { collaborationTools } from '../src/collaboration/tools.js'
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
      { id: 'builtin-ask', counts: [1], waitAt: 0, action: 'task.ask', builtin: true, expected: 'awaiting_input' },
      { id: 'builtin-child-wait', counts: [1], waitAt: 0, action: 'graph.start', builtin: true, childWait: true, expected: 'delegated' },
      { id: 'removed-builtin-ask', counts: [1], waitAt: 0, action: 'task.ask', unknownTool: true, expected: 'blocked' },
      { id: 'unknown-task-wait', counts: [1], waitAt: 0, action: 'task.wait', builtin: true, childWait: true, expected: 'blocked' },
      { id: 'normal-101', counts: [50, 51], waitAt: -1, expected: undefined },
      { id: 'historical-read-wait', counts: [100, 100], waitAt: 199, readTool: true, expected: 'blocked' },
      { id: 'removed-wait-tool', counts: [100, 100], waitAt: 199, unknownTool: true, expected: 'blocked' },
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
          const action = { runId: work.id, cellId, callIndex, idempotencyKey, action: scenario.action ?? 'chat.ask', args: {} }
          await ledger.reserve(idempotencyKey, idempotencyKey, { workId: work.id, tenantId: 't', agentId: 'a', sessionId: 's',
            principalId: 'u', threadId: null, requestVersion: 1, action })
          if (ordinal !== scenario.omitAt) await ledger.record(idempotencyKey, ordinal === scenario.waitAt
            ? scenario.childWait ? { ok: true, directive: { type: 'defer', reason: 'child', data: { taskRef: 'child' } } } : userInputWait('Which city?') : { ok: true, executionState: 'succeeded', value: 'read complete' })
        }
      }
      let outcome: { status: string } | undefined
      const service = { getSession: async () => session, heartbeat: async () => ({ ok: true, steer: [] }),
        recordEvent: async () => {}, saveSession: async () => {},
        complete: async (_work: unknown, result: { goalOutcome: { status: string } }) => { outcome = result.goalOutcome },
        waitWork: async (_work: unknown, result: { status: string }) => { outcome = result },
      } as unknown as ControlPlaneService
      assert.equal(await recoverWait(pool, service, work, undefined, scenario.unknownTool ? [] : scenario.builtin ? [...TASK_TOOLS, ...collaborationTools()] : [{ action: 'chat.ask', effect: scenario.readTool ? 'read' : 'uncertain' }]), scenario.expected !== undefined, scenario.id)
      assert.equal(outcome?.status, scenario.expected, scenario.id)
      if (['awaiting_input', 'delegated'].includes(scenario.expected ?? '')) assert.equal(history.filter(item => 'type' in item && item.type === 'function_call_output').length, scenario.counts.length)
    }
  } finally { await db.close() }
})


it('restores completed local Python output and artifacts before closing unstarted siblings at an input wait', async () => {
  const db = new PGlite()
  const pool: SqlPool = { query: async (sql, args) => {
    const result = await db.query<Record<string, unknown>>(sql, args)
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
  }, connect: async () => ({ query: pool.query, release() {} }) }
  try {
    await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
    const work: WorkItem = { id: 'local-python', tenantId: 't', agentId: 'a', sessionId: 's', principalId: 'u',
      kind: 'turn', lane: 'interactive', triggerRef: 'm', fence: 2, homeEpoch: 1, leaseToken: 'lease' }
    await db.exec(`INSERT INTO lingxios.agent_work_items
      (id,tenant_id,agent_id,session_id,principal_id,kind,lane,trigger_ref,status,fence,lease_token_hash,lease_expires_at)
      VALUES ('local-python','t','a','s','u','turn','interactive','m','leased',2,'test-token',NOW()+INTERVAL '5 minutes')`)
    const calls = ['local', 'ask', 'later'].map(callId => ({ type: 'function_call' as const, name: 'ipython', callId,
      stepId: `step-${callId}`, arguments: JSON.stringify({ code: callId === 'local' ? 'print(42)' : callId }),
      historySource: { workId: work.id, requestVersion: 1 } }))
    const session = { history: [...calls], request: { workId: work.id, revisions: [] } } as unknown as SessionRecord
    const artifact = { id: 'answer', path: 'answer.txt', name: 'answer.txt', mime: 'text/plain', size: 2,
      sha256: 'a'.repeat(64) }
    const output = JSON.stringify({ stdout: '42\n', stderr: '', result: 42, truncated: false, artifacts: [artifact], receipts: [] })
    const steps = new PgStepStore(pool)
    await steps.save({ workId: work.id, fence: 2, leaseTokenHash: 'test-token' }, { id: 'step-local', requestVersion: 1,
      kind: 'ipython', input: { callId: 'local', code: 'print(42)' }, output, artifacts: [artifact] })
    const ledger = new PgActionLedger(pool)
    const idempotencyKey = JSON.stringify([work.id, 'step-ask', 0])
    const action = { runId: work.id, cellId: 'step-ask', callIndex: 0, idempotencyKey, action: 'task.ask', args: { question: 'Which city?' } }
    await ledger.reserve(idempotencyKey, idempotencyKey, { workId: work.id, tenantId: 't', agentId: 'a', sessionId: 's',
      principalId: 'u', threadId: null, requestVersion: 1, action })
    await ledger.record(idempotencyKey, userInputWait('Which city?'))
    assert.equal((await db.query("SELECT * FROM lingxios.agent_action_intents WHERE intent->'action'->>'cellId'=$1", ['step-local'])).rows.length, 0)
    let waited: unknown
    const service = { getSession: async () => session, heartbeat: async () => ({ ok: true, steer: [] }),
      recordEvent: async () => {}, saveSession: async () => {}, complete: async () => assert.fail('valid input wait must not complete'),
      waitWork: async (_work: unknown, outcome: unknown) => { waited = outcome },
    } as unknown as ControlPlaneService
    assert.equal(await recoverWait(pool, service, work, undefined, TASK_TOOLS), true)
    assert.equal((waited as { status: string }).status, 'awaiting_input')
    const outputs = () => session.history.filter((item): item is Extract<SessionRecord['history'][number], { type: 'function_call_output' }> =>
      'type' in item && item.type === 'function_call_output')
    assert.equal(outputs().find(item => item.callId === 'local')?.output, output, 'durable local output must not become not_started')
    assert.deepEqual(JSON.parse(outputs().find(item => item.callId === 'local')!.output).artifacts, [artifact])
    assert.equal(JSON.parse(outputs().find(item => item.callId === 'later')!.output).executionState, 'not_started')
    assert.deepEqual((await steps.get(work.id, 'step-local', 1))?.artifacts, [artifact])
    assert.equal(outputs().length, 3)
    // Repeated recovery keeps the already persisted output rather than duplicating it.
    assert.equal(await recoverWait(pool, service, work, undefined, TASK_TOOLS), true)
    assert.equal(outputs().length, 3)
    assert.equal(outputs().find(item => item.callId === 'local')?.output, output)
  } finally { await db.close() }
})
