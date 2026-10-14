import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS } from '../dist/src/index.js'
import { createWorker } from '../dist/src/worker/index.js'
import { createRunView, consumeRunStreamEvent } from '../dist/src/ui/index.js'

// Reproduce deleted prior evidence, mid-turn revocation, durable failure after reopen,
// and queue recovery through public app/worker APIs and a local HTTP model fixture.
const directory = await mkdtemp(join(tmpdir(), 'lingxios-revoked-session-'))
const db = new PGlite(join(directory, 'db'))
const pool = { query: async (sql, params) => {
  const result = await db.query(sql, params)
  return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
}, connect: async () => ({ query: pool.query, release() {} }) }
let revoked = false, revokeDuringModel = false, modelCalls = 0
const observations = [], states = []
const model = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  modelCalls++
  observations.push({ revoked, containsRevokedEvidence: JSON.stringify(payload.messages).includes('REVOKED_SOURCE_SECRET') })
  if (revokeDuringModel) { revoked = true; revokeDuringModel = false }
  if (payload.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
  } else {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ model: 'fixture', choices: [{ message: { content: '{"missing":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }))
  }
})
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
const options = { database: pool, homesRoot: join(directory, 'homes'), responsePolicy: 'fast',
  contextProvider: {
    authorizeRequest: async (_work, request) => {
      if (revoked && request.evidence.items.length) throw new Error('source permission revoked')
    },
    loadContext: async work => ({ persona: { name: 'A', role: '', instructions: '' }, capabilities: [],
      messages: [{ ref: work.triggerRef, authorId: 'u', authorName: 'U', authorKind: 'human', body: work.meta.text, createdAt: 'now' }],
      evidence: revoked ? [] : [{ marker: 'S1', sourceId: 'source', sourceVersion: 'v1', chunkId: 'chunk', title: 'Source', excerpt: 'REVOKED_SOURCE_SECRET' }] }),
  },
}
let control, worker
const open = async () => {
  control = await createLingxiOS(options)
  worker = createWorker({ controlPlane: control, kernel: { homesRoot: options.homesRoot },
    model: { id: 'fixture', apiKey: 'fixture', baseUrl: `http://127.0.0.1:${model.address().port}/v1` },
    worker: { healthPort: 0 }, modelBudget: { maxModelCalls: 8 } })
}
const identity = runId => ({ runId, tenantId: 't', agentId: 'a', sessionId: 's', principalId: 'u' })
const enqueue = id => control.enqueue({ ...identity(id), id, text: 'Say hello.', codeExecution: 'disabled' })
const read = async id => {
  const state = await control.readRunState(identity(id))
  assert.ok(state)
  states.push({ id, status: state.run.status, fence: state.run.fence })
  return state
}
try {
  await db.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'))
  await open()
  await enqueue('before-delete')
  await worker.runNext()
  assert.equal((await read('before-delete')).run.status, 'succeeded')
  revoked = true
  await enqueue('after-delete')
  await worker.runNext()
  assert.equal((await read('after-delete')).run.status, 'succeeded')
  assert.ok(observations.some(item => item.revoked))
  assert.ok(observations.filter(item => item.revoked).every(item => !item.containsRevokedEvidence))
  revoked = false
  revokeDuringModel = true
  await enqueue('revoked-mid-turn')
  await worker.runNext()
  assert.equal((await read('revoked-mid-turn')).run.status, 'failed')
  await worker.stop(); await control.stop()
  await open()
  const reopened = await read('revoked-mid-turn')
  const view = consumeRunStreamEvent(createRunView('revoked-mid-turn'), { type: 'state', state: reopened })
  assert.equal(view.lifecycle, 'failed', 'refresh must restore a terminal failure')
  await enqueue('queue-recovered')
  await worker.runNext()
  assert.equal((await read('queue-recovered')).run.status, 'succeeded')
  assert.equal((await read('revoked-mid-turn')).run.fence, reopened.run.fence, 'failed work must not run again')
  const report = { status: 'passed', generatedAt: new Date().toISOString(),
    reproduce: 'npm run build && node scripts/check-revoked-session.mjs', states, modelCalls,
    revokedEvidenceExcluded: observations.filter(item => item.revoked).every(item => !item.containsRevokedEvidence),
    refreshedLifecycle: view.lifecycle, limitations: ['Scripted local model; PGlite PostgreSQL; no production mutation.'] }
  await mkdir(new URL('../release-results/', import.meta.url), { recursive: true })
  await writeFile(new URL('../release-results/revoked-session.json', import.meta.url), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await worker?.stop(); await control?.stop(); await db.close()
  await new Promise(resolve => model.close(resolve))
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
  assert.ok(directory.startsWith(join(tmpdir(), 'lingxios-revoked-session-')))
  await rm(directory, { recursive: true, force: true })
}
