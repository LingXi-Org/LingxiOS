import assert from 'node:assert/strict'
import { it } from 'node:test'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { PGlite } from '@electric-sql/pglite'
import { createLingxiOS } from '../src/app/index.js'
import { AgentRuntime } from '../src/runtime/runtime.js'
import { OpenAIChatDriver } from '../src/model/openai.js'
import { HttpHostClient } from '../src/host/http-client.js'
import type { SqlPool } from '../src/control-plane/pg-store.js'
import type { RunStreamEvent, RealtimeStore } from '../src/app/realtime.js'
import type { PreviewSnapshot } from '../src/protocol/preview.js'
import { consumeRunStreamEvent, createRunView } from '../src/ui/index.js'
import { abortable } from '../src/deadline.js'
import { nullLogger } from '../src/logging.js'
import type { ToolDefinition } from '../src/tools/definition.js'

for (const scenario of [
  { request: '你好', chunks: ['你好', '！很高兴见到你。'] },
  { request: '你知道我学习了什么吗', chunks: ['根据学习记录，', '你已经学习了分数。'] },
  { request: '原样输出 JSON', chunks: ['{"body":"正文",', '"status":"示例数据"}'] },
  { request: '读取学习记录后回答', chunks: ['根据刚读取的记录，', '你已经学习了分数。'], tool: true },
]) for (const shared of [false, true]) it(`${scenario.request}: streams body over worker HTTP and ${shared ? 'another control plane' : 'local'} SSE before completion, then replays the committed result`, async t => {
  const db = new PGlite()
  await db.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  // PGlite has one connection. Hold it across BEGIN/COMMIT so concurrent SSE cannot see uncommitted rows.
  let tail = Promise.resolve()
  const acquire = async () => {
    let release!: () => void
    const previous = tail
    tail = new Promise<void>(resolve => { release = resolve })
    await previous
    return release
  }
  const query: SqlPool['query'] = async (sql, params) => {
    const result = await db.query<Record<string, unknown>>(sql, params)
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }
  }
  const pool: SqlPool = { async query(sql, params) {
    const release = await acquire()
    try { return await query(sql, params) } finally { release() }
  }, async connect() { return { query, release: await acquire() } } }
  const logger = { ...nullLogger, warn: (message: string, fields?: Record<string, unknown>) => t.diagnostic(message + ' ' + JSON.stringify(fields)),
    error: (message: string, fields?: Record<string, unknown>) => t.diagnostic(message + ' ' + JSON.stringify(fields)) }
  let snapshot: PreviewSnapshot | null = null
  const listeners = new Set<() => void>()
  const store: RealtimeStore = {
    async update(identity, _owner, fence, frame, seed) {
      if (seed) snapshot = structuredClone(seed)
      else if (frame.kind === 'reset') snapshot = { runId: identity.runId, fence, requestVersion: frame.requestVersion, attemptId: frame.attemptId, seq: frame.seq, draft: '' }
      else if (snapshot && snapshot.seq + 1 === frame.seq) snapshot = { ...snapshot, seq: frame.seq, draft: snapshot.draft + frame.text }
      else return 'missing'
      for (const notify of listeners) notify()
      return 'applied'
    },
    async read() { return snapshot },
    async clear() { snapshot = null; for (const notify of listeners) notify() },
    async subscribe(_identity, notify) { listeners.add(notify); return () => { listeners.delete(notify) } },
  }
  const tools: ToolDefinition[] = scenario.tool ? [{ action: 'learning.read', name: 'learning__read', description: 'Read learning records',
    effect: 'read' as const, approval: false, parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
    parse: () => ({}), authorize: async () => {}, execute: async () => ({ ok: true, value: { learned: '分数' } }) }] : []
  const app = await createLingxiOS({ database: pool, logger, tools, realtime: { allowDraft: () => true, ...(shared ? { store } : {}) } })
  const readerApp = shared ? await createLingxiOS({ database: pool, logger, realtime: { allowDraft: () => true, store } }) : app
  const identity = { runId: 'stream', tenantId: 'tenant', agentId: 'agent', sessionId: 'session', principalId: 'human' }
  await app.enqueue({ id: identity.runId, ...identity, text: scenario.request, mode: scenario.tool ? 'execute' : 'chat',
    codeExecution: 'disabled', deliveryMode: 'auto' })
  const controlPort = await app.listenControlPlane({ serviceToken: 'test-service', port: 0 })
  const host = new HttpHostClient({ baseUrl: `http://127.0.0.1:${controlPort}`, serviceToken: 'test-service', workerId: 'stream-worker' })
  const work = (await host.claimWork())!
  assert.equal((await host.loadContext(work)).previewAllowed, true)
  let releaseModel!: () => void
  const providerGate = new Promise<void>(resolve => { releaseModel = resolve })
  let releaseSecond!: () => void, secondBody!: () => void, calls = 0
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
  const secondSeen = new Promise<void>(resolve => { secondBody = resolve })
  const body = scenario.chunks.join('')
  let providerAt = 0, browserAt = 0, firstBody!: () => void, latestId = 0
  const bodySeen = new Promise<void>(resolve => { firstBody = resolve })
  const model = new OpenAIChatDriver('sse-stub', { apiKey: 'test', fetchImpl: async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    if (!request.stream) return Response.json({ model: 'stub', choices: [{ finish_reason: 'stop', message: { content: '{"missing":[]}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 10 } })
    if (scenario.tool && calls++ === 0) {
      assert.ok(request.tools.some((tool: { function: { name: string } }) => tool.function.name === 'learning__read'))
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read',
        function: { name: 'learning__read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
    }
    return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
      const encode = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)
      providerAt = performance.now()
      controller.enqueue(encode({ choices: [{ delta: { content: scenario.chunks[0], reasoning_content: 'PRIVATE REASONING' } }] }))
      await secondGate
      controller.enqueue(encode({ choices: [{ delta: { content: scenario.chunks[1] } }] }))
      await providerGate
      controller.enqueue(encode({ model: 'stub', choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10 } }))
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      controller.close()
    } }))
  } })
  const browser = http.createServer((request, result) => {
    const closed = new AbortController()
    result.once('close', () => closed.abort())
    void readerApp.streamRun(identity, { signal: closed.signal, lastEventId: request.headers['last-event-id'] as string | undefined ?? null }).then(async response => {
      result.writeHead(response.status, Object.fromEntries(response.headers))
      await pipeline(Readable.fromWeb(response.body!), result)
    }).catch(() => result.destroy())
  })
  await new Promise<void>(resolve => browser.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(browser.address() as { port: number }).port}`
  const stopBrowser = new AbortController()
  let view = createRunView(work.id), wire = ''
  const consume = (async () => {
    const response = await fetch(url, { signal: stopBrowser.signal })
    assert.equal(response.headers.get('x-accel-buffering'), 'no')
    const reader = response.body!.getReader(), decoder = new TextDecoder()
    let pending = ''
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        const chunk = decoder.decode(next.value, { stream: true })
        wire += chunk; pending += chunk
        let end: number
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, end); pending = pending.slice(end + 2)
          const line = frame.split('\n').find(value => value.startsWith('data: '))
          if (!line) continue
          const item = JSON.parse(line.slice(6)) as RunStreamEvent
          if (item.type === 'event') latestId = item.event.seq
          view = consumeRunStreamEvent(view, item)
          if (item.type === 'preview' && view.draft && !browserAt) { browserAt = performance.now(); firstBody() }
          if (item.type === 'preview' && view.draft === body) secondBody()
        }
      }
    } finally { await reader.cancel().catch(() => {}) }
  })()
  void consume.catch(() => {})
  const running = new AgentRuntime(host, model, { execute: async () => { throw new Error('Python must stay disabled') } }, { logger }).runWork(work)
  try {
    await abortable(bodySeen, AbortSignal.timeout(5000))
    assert.equal(view.draft, scenario.chunks[0])
    assert.equal(view.message, null)
    assert.equal((await app.readRunState(identity))?.run.status, 'leased')
    assert.equal((await pool.query('SELECT COUNT(*)::integer AS count FROM lingxios.agent_model_budget_calls WHERE observation IS NOT NULL')).rows[0]?.['count'], scenario.tool ? 1 : 0)
    releaseSecond()
    await abortable(secondSeen, AbortSignal.timeout(5000))
    assert.equal(view.draft, body)
    assert.equal(view.message, null)
    assert.doesNotMatch(wire, /PRIVATE REASONING/)
    releaseModel()
    await running
    await abortable(consume, AbortSignal.timeout(5000))
    assert.equal((view as ReturnType<typeof createRunView>).message?.body, body)
    assert.equal(view.lifecycle, 'succeeded')
    assert.equal(view.draft, '')
    const replay = await app.streamRun(identity, { lastEventId: String(latestId) })
    const replayed = await replay.text()
    assert.ok(replayed.includes(JSON.stringify(body).slice(1, -1)))
    assert.match(replayed, /candidateHash/)
    assert.doesNotMatch(replayed, /event: event/)
    await assert.rejects(app.streamRun({ ...identity, tenantId: 'other' }), /identity/)
    await assert.rejects(app.streamRun({ ...identity, principalId: 'other' }), /identity/)
    await assert.rejects(app.streamRun(identity, { lastEventId: '-1' }), /Last-Event-ID/)
    t.diagnostic(`SSE stub provider first content → UI draft: ${(browserAt - providerAt).toFixed(1)}ms; preview arrived before usage settlement`)
  } catch (error) {
    t.diagnostic('providerAt: ' + providerAt)
    t.diagnostic('internal phases: ' + JSON.stringify((await pool.query('SELECT kind FROM lingxios.agent_run_events ORDER BY seq')).rows))
    t.diagnostic('wire: ' + wire.slice(-2000))
    t.diagnostic('state: ' + JSON.stringify((await app.readRunState(identity))?.run))
    throw error
  } finally {
    releaseSecond(); releaseModel(); stopBrowser.abort()
    await running.catch(() => {}); await consume.catch(() => {})
    await new Promise<void>(resolve => { browser.close(() => resolve()); browser.closeAllConnections() })
    await readerApp.stop(); await app.stop(); await db.close()
    assert.equal(listeners.size, 0)
  }
})
