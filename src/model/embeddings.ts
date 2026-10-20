import { createHash } from 'node:crypto'
import { ModelDriverError } from '../errors.js'
import { acquireCircuit, modelFailure, readProviderErrorCode, providerRequestId, retryAfterMs, type ModelFailure } from './recovery.js'

const protocolFailure = (message: string) => new ModelDriverError(message, { kind: 'protocol', category: 'protocol', finishReasons: [] })

export interface EmbeddingOptions {
  inputCostMicrosPerMillion?: number
  id: string
  apiKey: string
  baseUrl?: string
  dimensions?: number
  /** Change when weights/preprocessing change while the provider model alias stays fixed. */
  indexVersion?: string
  requestTimeoutMs?: number
}

/** One bounded request. Durable indexing work, rather than the HTTP client, owns retries. */
export class OpenAIEmbeddingDriver {
  readonly cacheKey: string
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly circuitKey: string

  constructor(private readonly options: EmbeddingOptions) {
    this.options = { ...options }
    if (!options.id?.trim() || !options.apiKey?.trim()) throw new Error('embedding model id and apiKey are required')
    let url: URL
    try { url = new URL(options.baseUrl ?? 'https://api.openai.com/v1') }
    catch { throw new Error('invalid embedding base URL') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid embedding base URL')
    this.endpoint = `${url.href.replace(/\/+$/, '')}/embeddings`
    this.timeoutMs = options.requestTimeoutMs ?? 15_000
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) throw new Error('invalid embedding timeout')
    if (options.dimensions !== undefined && (!Number.isSafeInteger(options.dimensions) || options.dimensions < 1 || options.dimensions > 4096)) throw new Error('invalid embedding dimensions')
    if (options.indexVersion !== undefined && (!options.indexVersion.trim() || options.indexVersion.length>128)) throw new Error('invalid embedding index version')
    this.cacheKey = createHash('sha256').update(JSON.stringify([this.endpoint, options.id, options.dimensions ?? null,
      ...(options.indexVersion === undefined ? [] : [options.indexVersion])])).digest('hex')
    this.circuitKey = createHash('sha256').update(JSON.stringify(['embedding', this.endpoint, options.id, options.apiKey])).digest('hex')
  }

  async embed(input: readonly string[], signal?: AbortSignal) {
    // UTF-8 bytes conservatively bound input tokens without a tokenizer dependency.
    if (!Array.isArray(input) || !input.length || input.length > 32
      || input.some(text => typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 8000)) throw new Error('embedding input requires 1-32 nonempty strings of at most 8000 UTF-8 bytes')
    signal?.throwIfAborted()
    const settle = acquireCircuit(this.circuitKey, 60_000)
    let failure: ModelFailure | undefined
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new DOMException('embedding request timeout', 'TimeoutError')), this.timeoutMs)
    timer.unref?.()
    const combined = AbortSignal.any([...(signal ? [signal] : []), timeout.signal])
    combined.throwIfAborted()
    try {
    let response: Response
    try {
      response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', signal: combined,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({ model: this.options.id, input, encoding_format: 'float',
          ...(this.options.dimensions === undefined ? {} : { dimensions: this.options.dimensions }) }) })
    } catch (error) {
      combined.throwIfAborted()
      throw error
    }
    if (!response.ok) {
      const code = await readProviderErrorCode(response, combined)
      // Provider error bodies may echo credentials or input; never persist them in work errors.
      const requestId = providerRequestId(response.headers.get('x-request-id') ?? response.headers.get('request-id'))
      const retryAfter = retryAfterMs(response.headers.get('retry-after'))
      const classification = modelFailure({ status: response.status, code })
      throw new ModelDriverError(`embedding provider returned HTTP ${response.status}`, {
        kind: 'provider', status: response.status, category: classification.category, finishReasons: [],
        ...(code ? { providerCode: code } : {}),
        ...(requestId ? { requestId } : {}), ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
      })
    }
    if (!response.body) throw protocolFailure('embedding provider returned no response body')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 4 * 1024 * 1024) throw protocolFailure('embedding response exceeds 4 MiB')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    combined.throwIfAborted()
    let result: { model?: unknown; data?: unknown; usage?: { prompt_tokens?: unknown; total_tokens?: unknown } }
    try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
    catch { throw protocolFailure('embedding provider returned invalid JSON') }
    if (!result || typeof result !== 'object' || typeof result.model !== 'string' || !result.model.trim() || result.model.length > 256
      || !Array.isArray(result.data) || result.data.length !== input.length) throw protocolFailure('invalid embedding response envelope')
    const vectors: number[][] = new Array(input.length)
    let dimensions = this.options.dimensions
    for (const item of result.data) {
      if (!item || !Number.isSafeInteger(item.index) || item.index < 0 || item.index >= input.length || vectors[item.index]
        || !Array.isArray(item.embedding) || item.embedding.length < 1 || item.embedding.length > 4096
        || item.embedding.some((value: unknown) => typeof value !== 'number' || !Number.isFinite(value))) throw protocolFailure('invalid embedding vector or index')
      dimensions ??= item.embedding.length
      if (item.embedding.length !== dimensions) throw protocolFailure('embedding dimensions do not match')
      const norm = Math.hypot(...item.embedding)
      if (!Number.isFinite(norm) || norm === 0) throw protocolFailure('embedding vector has invalid magnitude')
      vectors[item.index] = item.embedding.map((value: number) => value / norm)
    }
    const prompt = result.usage?.prompt_tokens, total = result.usage?.total_tokens
    const available = Number.isSafeInteger(prompt) && Number(prompt) >= 0 && Number.isSafeInteger(total) && Number(total) >= Number(prompt)
    return { model: result.model, vectors, usage: { available, inputTokens: available ? Number(prompt) : 0, totalTokens: available ? Number(total) : 0 } }
    } catch (error) {
      failure = modelFailure(error, signal?.aborted)
      if (signal?.aborted) throw signal.reason
      if (error instanceof ModelDriverError) throw error
      throw new ModelDriverError(`embedding request failed (${failure.category})`, {
        kind: failure.category === 'unknown' ? 'protocol' : 'provider', category: failure.category, finishReasons: [],
      })
    } finally { clearTimeout(timer); settle(failure) }
  }
}
