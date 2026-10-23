import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS } from '../src/index.js'
import { createWorker } from '../src/worker/index.js'
import { OpenAIChatDriver } from '../src/model/openai.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import { nullLogger } from '../src/logging.js'

for (const authorized of [true, false]) it(`native companion Worker preserves authorization=${authorized}, actual usage and one execution`, { timeout: 20_000 }, async () => {
  const db = new PGlite(), directory = await mkdtemp(join(tmpdir(), 'native-companion-worker-'))
  await db.exec(await readFile(join(process.cwd(), 'db/schema.sql'), 'utf8'))
  let tail = Promise.resolve(), calls = 0, executions = 0, authorizations = 0
  const acquire = async () => { let release!: () => void; const prior = tail; tail = new Promise<void>(resolve => { release = resolve }); await prior; return release }
  const query: SqlPool['query'] = async (sql, params) => { const result = await db.query<Record<string, unknown>>(sql, params); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length } }
  const pool: SqlPool = { async query(sql, params) { const release = await acquire(); try { return await query(sql, params) } finally { release() } },
    async connect() { return { query, release: await acquire() } } }
  const identity = { runId: `native-companion-${authorized}`, tenantId: 'tenant', principalId: 'human', agentId: 'agent', sessionId: 'room' }
  const app = await createLingxiOS({ database: pool, logger: nullLogger, homesRoot: directory,
    realtime: { allowDraft: () => false, allowPublicText: () => true }, tools: [{
      action: 'fixture.read', name: 'fixture__read', description: 'Read a synthetic number.', effect: 'read', approval: false,
      parameters: { type: 'object', properties: {}, additionalProperties: false }, parse: () => ({}),
      authorize: async () => { authorizations++; if (!authorized) throw new Error('synthetic permission denied') },
      execute: async () => { executions++; return { ok: true, value: { answer: 42 } } },
    }] })
  const answer = authorized ? 'The synthetic answer is 42.' : 'The synthetic record cannot be read with this permission.'
  const model = new OpenAIChatDriver('native-companion-worker', { apiKey: 'synthetic', maxAttempts: 1, publicTextProtocol: 'purpose-json-v2',
    capabilities: { jsonObjectWithTools: false, parallelTools: false }, fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      assert.equal(body.stream, true, 'no extra semantic reviewer is needed')
      calls++
      const delta = calls === 1 ? { content: 'INTERNAL_COMPANION_SENTINEL read a synthetic number.',
        tool_calls: [{ index: 0, id: 'read-once', type: 'function', function: { name: 'fixture__read', arguments: '{}' } }] }
        : { content: JSON.stringify({ commentary: '', answer, outcome: { status: authorized ? 'satisfied' : 'blocked', gaps: authorized ? [] : ['The record is not authorized.'] } }) }
      return new Response('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] })
        + '\n\ndata: {"choices":[],"usage":{"prompt_tokens":17,"completion_tokens":9}}\n\ndata: [DONE]\n\n')
    } })
  const worker = createWorker({ controlPlane: app, model, logger: nullLogger, kernel: { homesRoot: directory }, worker: { id: 'native-companion-worker', healthPort: 0 } })
  try {
    await app.enqueue({ id: identity.runId, ...identity, text: 'Read the synthetic number and tell me the result.', mode: 'execute', codeExecution: 'disabled', deliveryMode: 'text' })
    await worker.runNext()
    const state = await app.readRunState(identity), events = await app.readEvents(identity)
    assert.ok(state)
    assert.equal(calls, 2, 'one native tool turn and one strict final answer; no correction loop')
    assert.equal(executions, authorized ? 1 : 0)
    assert.ok(authorizations > 0)
    assert.equal(state.run.status, authorized ? 'succeeded' : 'blocked')
    assert.equal(state.message?.body, answer)
    assert.equal(state.message?.envelope.goalOutcome.status, authorized ? 'satisfied' : 'blocked')
    assert.doesNotMatch(JSON.stringify(events), /INTERNAL_COMPANION_SENTINEL/)
    const ledger = await pool.query('SELECT observation FROM lingxios.agent_model_budget_calls WHERE work_id=$1', [identity.runId])
    assert.equal(ledger.rows.length, 2)
    for (const row of ledger.rows) assert.deepEqual((row['observation'] as { usage: unknown }).usage, { available: true, inputTokens: 17, outputTokens: 9 })
    await worker.runNext()
    assert.equal(calls, 2)
    assert.equal(executions, authorized ? 1 : 0, 'a completed work item does not execute the tool again')
  } finally { await worker.stop(); await app.stop(); await db.close(); await rm(directory, { recursive: true, force: true }) }
})
