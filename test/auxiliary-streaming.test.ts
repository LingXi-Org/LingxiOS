import assert from 'node:assert/strict'
import http from 'node:http'
import { it } from 'node:test'
import { OpenAIChatDriver } from '../src/model/openai.js'
import { modelFailure } from '../src/model/recovery.js'
import { ModelDriverError } from '../src/errors.js'
import type { ModelDriver } from '../src/model/driver.js'

type Failure = 'idle' | 'total' | 'request' | 'cancel' | 'length' | 'invalid-json' | 'invalid-event'
  | 'missing-done' | 'premature-done' | 'empty' | 'tools' | 'usage-idle' | 'truncated-tail' | 'comment-tail'
const usage = { prompt_tokens: 11, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 4 } }
const measuredUsage = { available: true, inputTokens: 11, outputTokens: 7, reasoningTokens: 4 }

async function streamingFixture(failure?: Failure, contentDelayMs = 120) {
  const requests: Record<string, unknown>[] = []
  let firstByte!: () => void, disconnected!: () => void
  const started = new Promise<void>(resolve => { firstByte = resolve })
  const closed = new Promise<void>(resolve => { disconnected = resolve })
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    requests.push(body)
    const mode = requests.length === 1 ? failure : undefined
    const timers: ReturnType<typeof setTimeout>[] = []
    let heartbeat: ReturnType<typeof setInterval> | undefined
    response.on('close', () => {
      timers.forEach(clearTimeout)
      if (heartbeat) clearInterval(heartbeat)
      if (requests.length === 1) disconnected()
    })
    if (!body['stream']) {
      timers.push(setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ model: 'auxiliary-fixture', usage,
          choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }))
      }, 120))
      firstByte()
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (data: unknown) => response.write(`data: ${JSON.stringify(data)}\n\n`)
    const reasoning = () => send({ choices: [{ delta: { reasoning_content: 'SYNTHETIC_REASONING_ONLY' }, finish_reason: null }] })
    reasoning()
    firstByte()
    if (mode === 'idle') return
    heartbeat = setInterval(reasoning, 20)
    if (mode === 'total' || mode === 'request' || mode === 'cancel') return
    timers.push(setTimeout(() => {
      if (heartbeat) clearInterval(heartbeat)
      const content = mode === 'invalid-json' ? 'SYNTHETIC_INVALID_JSON' : '{"ok":true}'
      const delta = mode === 'empty' ? {} : mode === 'tools'
        ? { content, tool_calls: [{ index: 0, id: 'call', function: { name: 'unexpected', arguments: '{}' } }] }
        : { content }
      send({ model: 'auxiliary-fixture', choices: [{ delta,
        finish_reason: mode === 'length' ? 'length' : mode === 'premature-done' ? null : 'stop' }] })
      send({ choices: [], usage })
      if (mode === 'usage-idle') return
      if (mode === 'invalid-event') response.write('data: SYNTHETIC_INVALID_EVENT\n\n')
      if (mode === 'truncated-tail') response.write('data: {"choices":')
      else if (mode === 'comment-tail') response.write(': synthetic heartbeat\n')
      else if (mode !== 'missing-done') response.write('data: [DONE]\n\n')
      response.end()
    }, requests.length === 1 ? contentDelayMs : 0))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { requests, started, closed, baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    }) }
}

function invoke(driver: ModelDriver, purpose: 'structured' | 'compaction', signal?: AbortSignal) {
  return purpose === 'structured' ? driver.structured({ instructions: 'Return synthetic JSON.', input: {}, signal })
    : driver.compact({ instructions: 'Return synthetic JSON.', items: [], signal })
}

for (const purpose of ['structured', 'compaction'] as const) {
  for (const ending of [undefined, 'missing-done', 'comment-tail'] as const) it(`opts ${purpose} into bounded SSE with ${ending ?? 'DONE'} and retains final content, usage and clone configuration`, async t => {
    const responseReadyMs = 600, firstByteTimeoutMs = 500
    const fixture = await streamingFixture(ending, responseReadyMs)
    try {
      const driver = new OpenAIChatDriver('auxiliary-fixture', { apiKey: 'synthetic-only', baseUrl: fixture.baseUrl,
        auxiliaryStreaming: true, maxAttempts: 1, firstByteTimeoutMs, streamIdleTimeoutMs: 500,
        requestTimeoutMs: 3000, recovery: { maxAttempts: 1, totalTimeoutMs: 3000 } })
      const start = performance.now()
      const result = await invoke(driver.singleAttempt(), purpose)
      assert.deepEqual(result.value, purpose === 'structured' ? { ok: true } : '{"ok":true}')
      assert.deepEqual(result.usage, measuredUsage)
      assert.equal(result.model, 'auxiliary-fixture')
      assert.equal(fixture.requests[0]?.['stream'], true)
      assert.deepEqual(fixture.requests[0]?.['stream_options'], { include_usage: true })
      assert.deepEqual(fixture.requests[0]?.['response_format'], { type: 'json_object' })
      assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_REASONING_ONLY/)
      assert.ok(performance.now() - start >= responseReadyMs, 'reasoning keeps a response alive beyond its first-byte deadline')
      t.diagnostic(JSON.stringify({ purpose, firstByteTimeoutMs, totalTimeoutMs: 3000, responseReadyMs,
        elapsedMs: Math.round((performance.now() - start) * 100) / 100, outcome: 'succeeded' }))
    } finally { await fixture.close() }
  })

  for (const failure of ['idle', 'total', 'request', 'cancel', 'length', 'invalid-json', 'invalid-event',
    'premature-done', 'empty', 'tools', 'usage-idle', 'truncated-tail'] as const) {
    if (purpose === 'compaction' && failure === 'invalid-json') continue // Compaction intentionally returns a string.
    it(`${purpose} rejects ${failure}, closes the response and permits the next request`, async () => {
      const fixture = await streamingFixture(failure)
      try {
        const driver = new OpenAIChatDriver('auxiliary-fixture', { apiKey: 'synthetic-only', baseUrl: fixture.baseUrl,
          // Protocol/usage assertions need a scheduling margin; only the
          // dedicated timeout cases impose their deliberately short deadline.
          auxiliaryStreaming: true, maxAttempts: 1, firstByteTimeoutMs: 1000,
          streamIdleTimeoutMs: failure === 'idle' ? 60 : 1000,
          requestTimeoutMs: failure === 'request' ? 180 : 3000,
          recovery: { maxAttempts: 1, totalTimeoutMs: failure === 'total' ? 180 : 3000 } })
        const controller = new AbortController()
        const pending = invoke(driver, purpose, controller.signal)
        const rejected = assert.rejects(pending, error => {
          if (failure === 'cancel') { assert.equal(modelFailure(error, controller.signal.aborted).category, 'cancelled'); return true }
          assert.ok(error instanceof ModelDriverError)
          if (['idle', 'total', 'request', 'usage-idle'].includes(failure)) assert.equal(modelFailure(error).category, 'timeout')
          if (['invalid-event', 'truncated-tail'].includes(failure)) assert.equal(modelFailure(error).category, 'protocol')
          if (failure === 'empty') assert.equal(error.message, purpose === 'structured'
            ? 'structured call returned no content' : 'compaction returned no summary')
          if (!['idle', 'total', 'request'].includes(failure)) {
            assert.deepEqual(error.diagnostics.usage, measuredUsage)
            assert.doesNotMatch(JSON.stringify(error), /SYNTHETIC_|unexpected/)
          }
          return true
        })
        if (failure === 'cancel') { await fixture.started; controller.abort(new Error('synthetic cancellation')) }
        await rejected
        await fixture.closed
        const recovered = await invoke(driver, purpose)
        assert.deepEqual(recovered.value, purpose === 'structured' ? { ok: true } : '{"ok":true}')
        assert.deepEqual(recovered.usage, measuredUsage)
        assert.equal(fixture.requests.length, 2)
      } finally { await fixture.close() }
    })
  }
}
