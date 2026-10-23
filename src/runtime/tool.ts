/**
 * Parsing and bounding of model tool calls.
 */
import { MAX_TOOL_OUTPUT_CHARS } from '../protocol/constants.js'
import { observationRef, receiptReferences, type ObservationRef } from '../context/observations.js'
import type { HostActionResult } from '../protocol/types.js'

/**
 * Parse the model-emitted tool arguments strictly: a JSON object with exactly
 * one non-empty string property `code`. Anything else is a protocol
 * violation the runtime converts into a bounded correction turn.
 */
export function parseIPythonArguments(raw: string): { code: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('ipython arguments must be strict JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ipython arguments must be a JSON object')
  }
  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 1 || keys[0] !== 'code') {
    throw new Error('ipython arguments must contain exactly one property: "code"')
  }
  const code = record['code']
  if (typeof code !== 'string' || !code.trim()) {
    throw new Error('ipython "code" must be a non-empty string')
  }
  return { code }
}

/**
 * Serialize a tool output for the model, truncating oversized payloads into
 * an explicit `{truncated, preview}` shape rather than corrupting JSON.
 */
export function boundedToolOutput(value: unknown, maxChars: number = MAX_TOOL_OUTPUT_CHARS, observations: ObservationRef[] = []): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 128) throw new Error('tool output budget must be at least 128 characters')
  // Native provenance belongs to the durable receipt, never the displayed or
  // model-facing rendering of that receipt. User business values stay intact.
  const cleanReceipt = (receipt: { result: HostActionResult }) => {
    const { memorySources: _sources, ...result } = receipt.result
    return { ...receipt, result }
  }
  const rendered = value && typeof value === 'object' && 'receipts' in value
    && Array.isArray(value.receipts) ? { ...value, receipts: value.receipts.map(cleanReceipt) } : value
  const serialized = JSON.stringify(rendered) ?? 'null'
  if (serialized.length <= maxChars) return serialized
  const references: ObservationRef[] = []
  for (const ref of observations) {
    if (JSON.stringify([...references, ref]).length > maxChars - 384) break
    references.push(ref)
  }
  const metadata = { truncated: true, originalCharacters: serialized.length,
    ...(references.length ? { observations: references, read: 'observations.read' } : {}),
    ...(observations.length > references.length ? { omittedReferences: observations.length - references.length } : {}) }
  // JSON escapes the preview again. Reserve its worst-case expansion and a possible split surrogate.
  return JSON.stringify({ ...metadata, preview: serialized.slice(0, Math.max(0, Math.floor((maxChars - JSON.stringify(metadata).length - 80) / 2))) })
}

/** Keep the canonical receipt outside any truncated preview and the business value. */
export function boundedDirectToolOutput(receipt: { action: string; idempotencyKey: string; result: HostActionResult },
  maxChars: number = MAX_TOOL_OUTPUT_CHARS, recovery?: { recovered: true }): string {
  const { evidence: _evidence, memorySources: _sources, ...result } = receipt.result
  const observed = result.ok && result.value !== undefined && result.approval === undefined && result.directive === undefined && result.executionState !== 'unknown'
  const metadata = { receipt: { action: receipt.action, idempotencyKey: receipt.idempotencyKey,
    ...(observed ? { sha256: observationRef(receipt.idempotencyKey, JSON.parse(JSON.stringify(result.value))).sha256 } : {}) }, ...recovery }
  const reserved = JSON.stringify(metadata).length - 1
  if (!Number.isSafeInteger(maxChars - reserved) || maxChars - reserved < 128) throw new Error('tool output budget must be at least 128 characters')
  // Read APIs already return an exact source range. Keep their schema and a
  // truthful continuation cursor when only the model-facing text needs to be
  // bounded. The durable value, evidence and canonical receipt are untouched.
  const range = observed ? boundedReadRange(result, metadata, maxChars) : undefined
  if (range !== undefined) return range
  const output = boundedToolOutput(result, maxChars - reserved, receiptReferences([receipt]))
  return JSON.stringify({ ...JSON.parse(output), ...metadata })
}

function boundedReadRange(result: HostActionResult, metadata: object, maxChars: number): string | undefined {
  const value = result.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const range = value as Record<string, unknown>
  const { text, offset, nextOffset, textLength } = range
  if (typeof text !== 'string' || !text || typeof range['sourceVersion'] !== 'string'
    || typeof range['sourceId'] !== 'string' && typeof range['id'] !== 'string'
    || !Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(textLength)
    || Number(textLength) < Number(offset) + text.length || typeof range['truncated'] !== 'boolean') return
  const end = Number(offset) + text.length
  if (nextOffset !== end && !(nextOffset === null && end === textLength)) return
  if (JSON.stringify({ ...result, ...metadata }).length <= maxChars) return
  const render = (length: number) => {
    // Preserve UTF-16 range offsets without publishing half a code point.
    if (length > 0 && /[\uD800-\uDBFF]/.test(text[length - 1]!)) length--
    const visibleEnd = Number(offset) + length, hasMore = visibleEnd < Number(textLength)
    return JSON.stringify({ ...result, value: { ...range, text: text.slice(0, length),
      nextOffset: hasMore ? visibleEnd : null, hasMore, truncated: true },
      modelView: { partial: true, originalRange: { offset, end },
        continuation: 'Only the visible text range is rendered; continue at value.nextOffset when value.hasMore. The receipt hash covers the original recorded value.' },
      ...metadata })
  }
  if (render(0).length >= maxChars) return
  let low = 0, high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (render(middle).length <= maxChars) low = middle
    else high = middle - 1
  }
  if (low === 0 || (low === 1 && /[\uD800-\uDBFF]/.test(text[0]!))) return
  return render(low)
}
