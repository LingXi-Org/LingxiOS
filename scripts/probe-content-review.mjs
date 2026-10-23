// Synthetic-only, repeatable before/after probe. Clock values are prescribed
// fixture service times, not a provider benchmark or a browser measurement.
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const [baseline, output] = process.argv.slice(2)
assert.ok(baseline && output, 'usage: node scripts/probe-content-review.mjs BASELINE_CHECKOUT NEW_OUTPUT_DIRECTORY')
await mkdir(output)
const roots = [resolve(baseline), resolve(new URL('..', import.meta.url).pathname)]
const reports = []
for (const root of roots) {
  const { AgentRuntime } = await import(pathToFileURL(root + '/dist/src/runtime/runtime.js'))
  const { durableProtocol } = await import(pathToFileURL(root + '/dist/test/protocol-fixture.js'))
  let clock = 0, turns = 0, reviews = 0, scopes = 0, firstBody = null, lastBody = null, committedAt = null, session = null, message
  const settlements = [], checks = [], events = []
  const work = { id: 'probe', tenantId: 'synthetic', agentId: 'agent', principalId: 'human', sessionId: 'session',
    kind: 'turn', lane: 'interactive', triggerRef: 'message', fence: 1, homeEpoch: 1, leaseToken: 'synthetic',
    meta: { mode: 'execute', deliveryMode: 'text' } }
  const host = { ...durableProtocol(item => settlements.push({ purpose: item.purpose, operation: item.operation ?? null })),
    claimWork: async () => null, heartbeat: async () => ({ ok: true }),
    loadContext: async () => ({ work, publicTextAllowed: true, persona: { name: 'Agent', role: '', instructions: '' }, tools: [], capabilities: [],
      messages: [{ ref: 'message', authorId: 'human', authorName: 'Human', authorKind: 'human', body: 'Explain first and second facts.', createdAt: 'now' }] }),
    loadSession: async () => session, saveSession: async (_work, value) => { session = structuredClone(value) },
    executeAction: async () => ({ ok: true, value: { requestVersion: 1, pending: [], truncated: false } }),
    emitEvent: async (_work, event) => {
      events.push({ kind: event.kind, at: clock })
      if (event.kind === 'public.text.delta' && event.data.text) { firstBody ??= clock; lastBody = clock }
      if (event.kind === 'response.content_checked') checks.push({ at: clock })
    },
    commitResult: async (_work, value) => { message = value; committedAt = clock }, completeWork: async () => {}, yieldWork: async () => {} }
  const usage = { available: true, inputTokens: 20, outputTokens: 5 }
  const model = { modelId: 'synthetic', previewFormat: 'user-text', publicTextProtocol: 'purpose-json-v1', maxOutputTokens: 100,
    compact: async () => { throw new Error('unexpected compaction') },
    run: async request => {
      turns++; clock += 20
      const text = turns === 1 ? 'First fact.' : 'First fact. The second fact is unavailable.'
      await request.onTextDelta?.(text, { purpose: 'answer' })
      return { text, output: [{ role: 'assistant', content: text }], usage }
    }, structured: async request => {
      if (Array.isArray(request.input.findings)) { scopes++; clock += 300; return { value: { deferred: [] }, model: 'synthetic', usage } }
      reviews++; clock += 30
      return { model: 'synthetic', usage, value: turns === 1
        ? { missing: [{ quote: 'second facts.', reason: 'The second fact is missing.' }], limitations: [], deferred: [] }
        : { missing: [], limitations: [{ quote: 'The second fact is unavailable.', requestQuote: 'second facts.', reason: 'Requested fact is unavailable.' }], deferred: [] } }
    } }
  const runtime = new AgentRuntime(host, model, { execute: async () => { throw new Error('unexpected tool') } })
  await runtime.runWork(work); await runtime.drainBackground()
  assert.equal(message?.envelope.goalOutcome.status, 'partial', 'honest limitations must not become success')
  assert.equal(turns, 2); assert.equal(reviews, 2); assert.equal(checks.length, 2)
  assert.equal(settlements.length, turns + reviews + scopes)
  assert.ok(firstBody !== null && lastBody !== null && committedAt !== null)
  reports.push({ sourceSha256: createHash('sha256').update(await readFile(root + '/src/outcome/content-check.ts')).digest('hex'),
    modelCalls: settlements.length, main: turns, contentReview: reviews, scopeReview: scopes,
    firstUsefulBodyMs: firstBody, lastBodyMs: lastBody, committedAtMs: committedAt, afterBodyMs: committedAt - lastBody,
    outcome: message.envelope.goalOutcome.status, completeDelivery: false, checks: checks.length, settlements, events })
}
assert.equal(reports[0].scopeReview, 2)
assert.equal(reports[1].scopeReview, 0)
assert.equal(reports[1].firstUsefulBodyMs, reports[0].firstUsefulBodyMs)
assert.equal(reports[1].outcome, reports[0].outcome)
const report = { fixture: 'controlled service clock: main=20ms; full review=30ms; legacy scope=300ms; zero transport/DB delay',
  metricBoundary: 'persisted useful public body to runtime commit; excludes product IM/SSE/browser finish', baseline: reports[0], candidate: reports[1] }
await writeFile(output + '/results.json', JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ baseline: reports[0], candidate: reports[1] }, (_key, value) => Array.isArray(value) ? undefined : value))
