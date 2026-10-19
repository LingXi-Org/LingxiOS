import assert from 'node:assert/strict'
import http from 'node:http'
import { it } from 'node:test'
import { OpenAIChatDriver } from '../src/model/openai.js'
import { modelFailure } from '../src/model/recovery.js'

// The failure model is recorded before implementation in reasoning-effort-contract.md.
it('characterizes first-byte timeout for delayed JSON versus ongoing reasoning SSE', async t => {
  const requests: boolean[] = []
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream: boolean }
    requests.push(body.stream)
    const payload = { model: 'timeout-fixture', usage: { prompt_tokens: 11, completion_tokens: 3 },
      choices: [{ finish_reason: 'stop', ...(body.stream ? { delta: { content: '{"ok":true}' } }
        : { message: { content: '{"ok":true}' } }) }] }
    let reasoning: ReturnType<typeof setInterval> | undefined
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      reasoning = setInterval(() => response.write(`data: ${JSON.stringify({ choices: [
        { delta: { reasoning_content: 'synthetic reasoning' }, finish_reason: null },
      ] })}\n\n`), 20)
    }
    const completion = setTimeout(() => {
      if (reasoning) clearInterval(reasoning)
      if (!body.stream) response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body.stream ? `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n` : JSON.stringify(payload))
    }, 120)
    response.on('close', () => { clearTimeout(completion); if (reasoning) clearInterval(reasoning) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const model = new OpenAIChatDriver('timeout-fixture', { apiKey: 'synthetic-only',
    baseUrl: `http://127.0.0.1:${address.port}`, maxAttempts: 1,
    firstByteTimeoutMs: 60, streamIdleTimeoutMs: 60, requestTimeoutMs: 500,
    recovery: { maxAttempts: 1, totalTimeoutMs: 500 } })
  const samples: { purpose: string; elapsedMs: number; outcome: string }[] = []
  try {
    for (const purpose of ['structured', 'compaction'] as const) {
      const start = performance.now()
      await assert.rejects(purpose === 'structured'
        ? model.structured({ instructions: 'Return synthetic JSON.', input: {} })
        : model.compact({ instructions: 'Return synthetic JSON.', items: [] }), error => modelFailure(error).category === 'timeout')
      samples.push({ purpose, elapsedMs: Math.round((performance.now() - start) * 100) / 100, outcome: 'timeout' })
    }
    const start = performance.now(), previews: string[] = []
    const result = await model.run({ instructions: 'Return synthetic JSON.', items: [], codeExecution: 'disabled',
      onTextDelta: delta => previews.push(delta) })
    samples.push({ purpose: 'streamed-turn', elapsedMs: Math.round((performance.now() - start) * 100) / 100, outcome: 'succeeded' })
    assert.equal(result.text, '{"ok":true}')
    assert.deepEqual(previews, ['{"ok":true}'])
    assert.deepEqual(requests, [false, false, true])
    t.diagnostic(JSON.stringify({ firstByteTimeoutMs: 60, totalTimeoutMs: 500, responseReadyMs: 120,
      reasoningIntervalMs: 20, samples }))
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
})
