// Opt-in metered diagnostic. Synthetic question only; no host dispatch or DB.
import { OpenAIChatDriver } from '../dist/src/model/openai.js'
import { TASK_TOOLS } from '../dist/src/tools/catalog.js'

const names = ['receipt-legacy', 'receipt-explicit', 'resource-legacy', 'resource-explicit']
const cases = process.argv.slice(2)
if (process.env.LINGXIOS_LIVE_TASK_SCHEMA !== '1' || !cases.length || cases.length > 4
  || cases.some(value => !names.includes(value)) || new Set(cases).size !== cases.length) {
  console.error('Explicit opt-in required: LINGXIOS_LIVE_TASK_SCHEMA=1 node scripts/probe-task-schema-compat.mjs <1..4 unique cases: ' + names.join(', ') + '>. Maximum 4 requests, 512 output tokens each; no retries.')
  process.exit(2)
}
const { OPENAI_API_KEY: apiKey, OPENAI_BASE_URL: baseUrl, OPENAI_MODEL: id } = process.env
if (!apiKey || !baseUrl || !id) { console.error('Configured provider credentials/base URL/model are required.'); process.exit(2) }
const target = new URL(baseUrl)
if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash) {
  console.error('A credential-free HTTPS provider base URL is required.'); process.exit(2)
}
let totalRequests = 0
for (const name of cases) {
  const action = name.startsWith('receipt') ? 'task.check_receipt' : 'task.check_resource'
  const tool = structuredClone(TASK_TOOLS.find(item => item.action === action))
  if (name === 'receipt-legacy') tool.parameters.properties.expected = {}
  if (name === 'resource-legacy') for (const key of ['args', 'expected']) delete tool.parameters.properties[key].additionalProperties
  let requests = 0
  const model = new OpenAIChatDriver(id, { apiKey, baseUrl, maxAttempts: 1, maxThinkingTokens: 0, maxOutputTokens: 512,
    requestTimeoutMs: 45_000, firstByteTimeoutMs: 30_000, streamIdleTimeoutMs: 30_000,
    recovery: { maxAttempts: 1, totalTimeoutMs: 45_000 }, publicTextProtocol: 'purpose-json-v3',
    publicTextContinuation: 'typed-message-v1', publicAnswerTool: 'native-v3',
    capabilities: { jsonObjectWithTools: false, parallelTools: true },
    fetchImpl: async (url, init) => {
      if (++requests > 1 || ++totalRequests > 4) throw new Error('probe_request_bound')
      const body = JSON.parse(init.body)
      if (body.tool_choice !== 'required' || body.max_tokens !== 512 || body.tools.length !== 2) throw new Error('probe_wire_bound')
      return fetch(url, init)
    } })
  const request = { instructions: 'You are a helpful learning assistant. Answer in Chinese. Use public_answer for all public output. Use business tools only if needed.',
    items: [{ role: 'user', content: '只用一句话回答：Wi-Fi 是否等于互联网？' }], tools: [tool], codeExecution: 'disabled', signal: AbortSignal.timeout(45_000) }
  // Conservative UTF-8 estimate bounds the synthetic input independently of billing.
  if (model.generationInputTokens(request) > 16_000) throw new Error('probe_input_bound')
  const start = performance.now()
  try {
    const result = await model.run(request)
    console.log(JSON.stringify({ case: name, requests, elapsedMs: performance.now() - start, accepted: true,
      publicAnswer: !!result.publicAnswerCall, businessCalls: result.output.length, usage: result.usage }))
  } catch (error) {
    const diagnostics = error?.diagnostics
    console.log(JSON.stringify({ case: name, requests, elapsedMs: performance.now() - start, accepted: false,
      ...(diagnostics ? { protocolCode: diagnostics.protocolCode, protocolDetail: diagnostics.protocolDetail,
        finishReasons: diagnostics.finishReasons.map(reason => ['stop', 'tool_calls', 'length', 'content_filter', 'function_call'].includes(reason) ? reason : 'other'),
        usage: diagnostics.usage } : { failure: 'transport_or_configuration' }) }))
  }
}
