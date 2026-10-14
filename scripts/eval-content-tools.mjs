// Failure inventory: a tool-delivered card is required again in prose; a mere claim,
// failed tool or stale revision supplies missing work; requests leak into receipts.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { checkCandidateContent } from '../dist/src/outcome/content-check.js'
import { snapshotEvidence } from '../dist/src/context/evidence.js'
import { OpenAIChatDriver } from '../dist/src/model/openai.js'
import { releaseVersions } from '../dist/src/versions.js'

assert.equal(process.argv.length, 3, 'provide one new output directory')
const directory = process.argv[2]
await mkdir(directory)
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const source = await readFile(new URL('../src/outcome/content-check.ts', import.meta.url))
const model = new OpenAIChatDriver(process.env.AGENT_OS_MODEL, { apiKey: process.env.AGENT_OS_MODEL_API_KEY,
  baseUrl: process.env.AGENT_OS_MODEL_BASE_URL, maxThinkingTokens: 0, maxOutputTokens: 2048,
  contextWindowTokens: 32768, maxAttempts: 1, requestTimeoutMs: 120000 })
const request = { version: 1, workId: 'tool-delivery', tenantId: 'eval', sessionId: 'eval', authorId: 'human', sourceRef: 'message',
  originalText: 'Create an editable invitation draft card for the Friday book club at the library at 3 pm. Wait for me to click Publish.',
  revisions: [], attachments: [], evidence: snapshotEvidence('evidence', []) }
const body = 'The invitation draft is ready for your review. Publication awaits your confirmation.'
const fields = { title: 'Friday book club', location: 'library', time: '3 pm', day: 'Friday' }
const step = { id: 'draft', requestVersion: 1, kind: 'invitation.create_draft_card', output: { ok: true,
  value: { result: { cardId: 'draft-1', revision: 1, fields }, state: { revision: 1, visibleHash: hash(fields) } } } }
const observation = { checker: 'action', status: 'passed', evidence: { action: 'invitation.create_draft_card',
  expected: { revision: 1, visibleHash: hash(fields) }, actual: { revision: 1, visibleHash: hash(fields) } } }
const samples = [
  { id: 'verified-tool-card-without-prose-copy', request, body, steps: [step], checks: [observation], expectGap: false },
  { id: 'claim-without-tool-result', request, body, steps: [], checks: [], expectGap: true },
  { id: 'failed-tool-does-not-create-card', request, body, steps: [{ ...step, output: { ok: false, error: 'Draft was not created.' } }],
    checks: [{ ...observation, status: 'failed', evidence: { actual: null } }], expectGap: true },
  { id: 'old-card-does-not-fulfill-revision', request: { ...request, revisions: [{ id: 'move', text: 'Change the invitation to Saturday at 4 pm.',
    author: { id: 'human', kind: 'human' }, createdAt: '2' }] }, body: 'The draft is updated to Saturday at 4 pm. Publication awaits your confirmation.',
    steps: [step], checks: [observation], expectGap: true },
]
const results = []
for (const sample of samples) {
  const result = await checkCandidateContent(model, sample.request, sample.body, [], 32768, AbortSignal.timeout(180000), [], sample.checks,
    { steps: sample.steps, dependencies: [] })
  const gap = result.missing.length + result.limitations.length > 0
  results.push({ id: sample.id, inputSha256: hash(sample), error: result.error ?? null, missingCount: result.missing.length,
    limitationCount: result.limitations.length, passed: !result.error && gap === sample.expectGap, usage: result.usage,
    deferralUsage: result.deferralReview?.usage })
  console.log(JSON.stringify(results.at(-1)))
}
const report = { runtime: releaseVersions.runtime, sourceSha256: hash(source), cases: results,
  passed: results.every(result => result.passed) && hash(source) === hash(await readFile(new URL('../src/outcome/content-check.ts', import.meta.url))) }
await writeFile(`${directory}/results.json`, JSON.stringify(report, null, 2) + '\n')
process.exitCode = report.passed ? 0 : 1
