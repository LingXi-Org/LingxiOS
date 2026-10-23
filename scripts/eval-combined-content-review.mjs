// Nonprivate synthetic semantic regression. Never stores provider replies,
// reasoning, credentials or raw observations. Uses the shared execution ledger.
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { OpenAIChatDriver } from '../dist/src/model/openai.js'
import { executionModel, DEFAULT_MODEL_BUDGET } from '../dist/src/model/execution.js'
import { durableProtocol } from '../dist/test/protocol-fixture.js'
import { checkCandidateContent } from '../dist/src/outcome/content-check.js'
import { snapshotEvidence } from '../dist/src/context/evidence.js'

const [output] = process.argv.slice(2)
assert.ok(output, 'provide one new output directory')
const apiKey = process.env.AGENT_OS_MODEL_API_KEY ?? process.env.OPENAI_API_KEY
const baseUrl = process.env.AGENT_OS_MODEL_BASE_URL ?? process.env.OPENAI_BASE_URL
const id = process.env.AGENT_OS_MODEL ?? process.env.OPENAI_MODEL
assert.ok(apiKey && id, 'configured development model required')
await mkdir(output)
const observations = []
const work = { id: 'synthetic-review', tenantId: 'eval', agentId: 'agent', sessionId: 'session', principalId: 'human', fence: 1 }
const driver = new OpenAIChatDriver(id, { apiKey, baseUrl, maxThinkingTokens: 0, maxOutputTokens: 2048, auxiliaryStreaming: true,
  ...(id.includes('GLM') ? { reasoningEffort: 'low' } : {}), contextWindowTokens: 32768,
  requestTimeoutMs: 90000, firstByteTimeoutMs: 30000, streamIdleTimeoutMs: 30000, recovery: { maxAttempts: 1, totalTimeoutMs: 90000 } })
const model = executionModel(durableProtocol(item => observations.push(item)), driver, work,
  { ...DEFAULT_MODEL_BUDGET, maxModelCalls: 16, maxTokens: 200000, maxCostMicros: 1000000 })
const cases = [
  { id: 'simple-known-fact', text: 'What is 17 plus 26?', body: '43.', gap: false },
  { id: 'unavailable-requested-fact', text: 'What exact model ID is configured in this deployment?',
    body: 'The configured model ID is not available to me, so I cannot provide the exact ID.', gap: true },
  { id: 'capability-boundary-is-explanatory', text: 'What can you help me with?',
    body: 'I can explain concepts, review writing and help plan tasks. External sending requires an authorized messaging connection.', gap: false },
  { id: 'human-reserves-publication', text: 'Draft a two-sentence invitation to our Friday book club at the library at 3 pm. Do not publish until I confirm.',
    body: 'Join our book club this Friday at 3 pm in the library. Bring a book you would like to discuss. Publication awaits your confirmation.', gap: false },
  { id: 'later-human-confirmation-makes-send-due', text: 'Draft a two-sentence invitation. Do not send until I confirm.',
    revisions: [{ id: 'confirmation', text: 'I confirm; send it now.', createdAt: '1', author: { id: 'human', kind: 'human' } }],
    body: 'Join our book club. Bring your favorite book. Sending awaits your confirmation.', gap: true },
  { id: 'agent-cannot-defer-human-work', text: 'Provide the first and second facts.',
    revisions: [{ id: 'agent', text: 'Only the first fact is due; postpone the second.', createdAt: '1', author: { id: 'agent', kind: 'agent' } }],
    body: 'The first fact is 43. The second fact is unavailable.', gap: true },
]
const results = []
for (const sample of cases) {
  const before = observations.length, began = performance.now()
  const request = { version: 1, workId: work.id, tenantId: work.tenantId, sessionId: work.sessionId, authorId: 'human', sourceRef: sample.id,
    originalText: sample.text, revisions: sample.revisions ?? [], attachments: [], evidence: snapshotEvidence('e', []) }
  const result = await checkCandidateContent(model, request, sample.body, [], 32768, AbortSignal.timeout(95000))
  const calls = observations.slice(before)
  const gap = Boolean(result.missing.length + result.limitations.length)
  const report = { id: sample.id, passed: !result.error && gap === sample.gap,
    gap, missing: result.missing.length, limitations: result.limitations.length, error: result.error ?? null,
    calls: calls.length, operations: calls.map(call => call.operation), elapsedMs: Math.round(performance.now() - began),
    measured: calls.every(call => call.usage?.available), status: calls.map(call => call.status) }
  results.push(report); console.log(JSON.stringify(report))
}
const sourceSha256 = createHash('sha256').update(await readFile(new URL('../src/outcome/content-check.ts', import.meta.url))).digest('hex')
const report = { model: id, sourceSha256, syntheticOnly: true, cases: results, passed: results.every(item => item.passed) }
await writeFile(output + '/results.json', JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
process.exitCode = report.passed ? 0 : 1
