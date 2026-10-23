/** OS source-candidate development probe. NOT a Loop/product qualification.
 * Exactly one generation, no tool dispatch, no automatic retry or resampling.
 * Root/release owner alone executes after reviewing the candidate. This script
 * deliberately uses the owning source tree's driver, not a private product import.
 * Usage: LINGXIOS_SOURCE_CANDIDATE_PROBE=approved LINGXIOS_SOURCE_CANDIDATE_SHA=<frozen SHA>
 * OPENAI_API_KEY=... OPENAI_BASE_URL=https://api.siliconflow.cn/v1 node
 * scripts/probe-native-public-output.mjs /absolute/new-report.json
 */
import { open, stat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { OpenAIChatDriver } from '../dist/src/model/openai.js'
import { JSONParser } from '@streamparser/json'

const output = process.argv[2]
const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
const clean = execFileSync('git', ['status', '--porcelain'], { cwd: sourceRoot, encoding: 'utf8' }).trim() === ''
if (process.env.LINGXIOS_SOURCE_CANDIDATE_PROBE !== 'approved' || !process.env.OPENAI_API_KEY
  || process.env.OPENAI_BASE_URL?.replace(/\/+$/, '') !== 'https://api.siliconflow.cn/v1'
  || process.env.LINGXIOS_SOURCE_CANDIDATE_SHA !== sourceCommit || !clean || !output || !isAbsolute(output)) {
  throw new Error('Explicit source-candidate opt-in, provider credential and a new absolute report path are required')
}
const driverPath = join(sourceRoot, 'dist/src/model/openai.js')
const builtAt = (await stat(driverPath)).mtimeMs
const sources = execFileSync('git', ['ls-files', 'src/**/*.ts'], { cwd: sourceRoot, encoding: 'utf8' }).trim().split('\n')
for (const source of sources) if ((await stat(join(sourceRoot, source))).mtimeMs > builtAt) throw new Error('Build the frozen source candidate before probing')
const compiledDriverSha256 = createHash('sha256').update(await readFile(driverPath)).digest('hex')
const dependencyLockSha256 = createHash('sha256').update(await readFile(join(sourceRoot, 'package-lock.json'))).digest('hex')
// Reserve the evidence path before any outbound request. A crash leaves the
// exclusive file behind; its uncertain outcome must be inspected, never retried.
const file = await open(output, 'wx', 0o600)
const began = performance.now()
const report = { qualification: 'OS-source-candidate-development-only', synthetic: true, productionOperations: 0,
  toolExecutions: 0, model: 'deepseek-ai/DeepSeek-V4.1-Flash', sourceCommit, compiledDriverSha256, dependencyLockSha256,
  requests: 0, status: 'pending', firstPublicAnswerMs: null, businessArgumentsCompleteMs: null,
  publicSourceSealed: false, semanticAcceptance: 'requires-independent-synthetic-excerpt-review',
  publicAnswerWhileArgumentsIncomplete: false, finishReasons: [], publicAnswerExcerpt: '', syntheticPublicAnswer: '', answerDeltas: [], toolIdentities: [] }
const tool = { name: 'visualize_save_fixture', action: 'visualize.save.fixture', description: 'Prepare a synthetic interactive diagram. This development fixture does not save or execute anything.',
  effect: 'read', approval: false, parameters: { type: 'object', properties: { name: { type: 'string' }, html: { type: 'string' } },
    required: ['name', 'html'], additionalProperties: false } }
const argumentParsers = new Map()
let sse = '', invalidWire = false
const observe = frame => {
  if (frame === '[DONE]') return
  let payload
  try { payload = JSON.parse(frame) } catch { invalidWire = true; return }
  // Access only native-call structure and finish reason. Never inspect, serialize
  // or persist provider reasoning fields, prompts, headers or credentials.
  const choice = payload.choices?.[0]
  if (choice?.finish_reason) report.finishReasons.push(choice.finish_reason)
  for (const call of choice?.delta?.tool_calls ?? []) {
    if (typeof call.index !== 'number') { invalidWire = true; continue }
    let entry = argumentParsers.get(call.index)
    if (!entry) {
      const parser = new JSONParser({ paths: ['$.arguments'], keepStack: false })
      parser.onValue = () => { report.businessArgumentsCompleteMs ??= performance.now() - began }
      entry = { parser, length: 0 }; argumentParsers.set(call.index, entry)
    }
    const delta = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
    entry.length += delta.length
    if (entry.length > 2_000_000) throw new Error('synthetic argument bound exceeded')
    try { entry.parser.write(delta) } catch { invalidWire = true }
  }
}
try {
  const model = new OpenAIChatDriver(report.model, { apiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL, publicTextProtocol: 'purpose-json-v3', nativeToolPublicOutput: 'envelope-v1',
    capabilities: { jsonObjectWithTools: false, parallelTools: false }, maxAttempts: 1, maxThinkingTokens: 0,
    maxOutputTokens: 4096, requestTimeoutMs: 90000,
    fetchImpl: async (url, init) => {
      if (++report.requests !== 1) throw new Error('probe permits exactly one request')
      const response = await fetch(url, init)
      if (!response.body) return response
      const decoder = new TextDecoder()
      return new Response(response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
        sse += decoder.decode(chunk, { stream: true })
        let boundary
        while ((boundary = sse.indexOf('\n')) !== -1) {
          const line = sse.slice(0, boundary).replace(/\r$/, ''); sse = sse.slice(boundary + 1)
          if (line.startsWith('data: ')) observe(line.slice(6))
        }
        controller.enqueue(chunk)
      } })), { status: response.status, statusText: response.statusText, headers: response.headers })
    } })
  const result = await model.run({ instructions: 'Explain the supplied facts and prepare the requested synthetic diagram. Use only the exposed fixture tool. The facts are already available; do not claim a save or execution occurred.',
    items: [{ role: 'user', content: 'Facts: Gather collects items. Check reviews those gathered items. Explain what each contributes and why Gather comes first, and prepare an interactive HTML diagram with a button switching the visible Gather/Check stage. The known explanation should be available while the diagram is being prepared.' }],
    tools: [tool], codeExecution: 'disabled', signal: AbortSignal.timeout(95000), onTextDelta: (text, metadata) => {
      if (metadata?.purpose !== 'answer' || !text) return
      report.firstPublicAnswerMs ??= performance.now() - began
      if (report.businessArgumentsCompleteMs === null) report.publicAnswerWhileArgumentsIncomplete = true
      if (report.publicAnswerExcerpt.length < 600) report.publicAnswerExcerpt = (report.publicAnswerExcerpt + text).slice(0, 600)
      if (report.syntheticPublicAnswer.length + text.length <= 20000) {
        if (report.answerDeltas.length < 4096) report.answerDeltas.push({ offset: report.syntheticPublicAnswer.length, length: text.length, elapsedMs: performance.now() - began })
        report.syntheticPublicAnswer += text
      }
    } })
  report.toolIdentities = result.output.filter(item => item.type === 'function_call').map(item => ({ whitelisted: item.name === tool.name,
    idPresent: !!item.callId, businessArgumentBytes: Buffer.byteLength(item.arguments) }))
  report.status = report.publicAnswerWhileArgumentsIncomplete && report.toolIdentities.length === 1 && !invalidWire ? 'protocol-capability-demonstrated' : 'not-demonstrated'
  report.usage = result.usage
} catch (error) {
  report.status = 'failed'
  report.failure = { name: error?.name ?? 'Error', category: error?.diagnostics?.category ?? null, protocolCode: error?.diagnostics?.protocolCode ?? null }
} finally {
  report.elapsedMs = performance.now() - began
  await file.writeFile(JSON.stringify(report, null, 2) + '\n'); await file.close()
}
console.log(JSON.stringify({ qualification: report.qualification, status: report.status, requests: report.requests, report: output }))
if (report.status !== 'protocol-capability-demonstrated') process.exitCode = 1
