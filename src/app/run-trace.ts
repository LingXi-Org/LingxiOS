import { NoEffectError } from '../tools/definition.js'
import { createHash } from 'node:crypto'
import type { SqlQueryable } from '../control-plane/pg-store.js'
import { readRunRecord, type RunIdentity } from './jobs.js'
import { modelOperation } from '../model/operation.js'

import type { RunTraceSpan, RunTraceSnapshot, TraceState } from '../protocol/run-trace.js'
export type { RunTraceSpan, RunTraceSnapshot, TraceState } from '../protocol/run-trace.js'
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const integer = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
const string = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && value.length <= 2000 ? value : null
const time = (value: unknown): number | null => value == null ? null : number(new Date(value as Date | string).getTime())
const id = (...values: unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex')
const rootId = (runId: string) => id('agent', runId)
const state = (value: unknown): TraceState => value === 'queued' || value === 'leased' ? 'running' : value === 'waiting' ? 'waiting'
  : value === 'partial' || value === 'blocked' ? value : value === 'succeeded' ? 'complete' : value === 'cancelled' ? 'cancelled' : value === 'failed' ? 'failed' : 'unknown'
const active = (value: unknown) => ['queued', 'leased', 'waiting'].includes(String(value))
const finish = (span: Omit<RunTraceSpan, 'revision'>): RunTraceSpan => ({ ...span, revision: id(span) })

/** Current root authorization and each descendant's frozen audience are checked
 * on every read, including replay. Bounded traversal never returns raw identities. */
export async function readRunTrace(database: SqlQueryable, identity: RunIdentity): Promise<RunTraceSnapshot | null> {
  const root = await readRunRecord(database, identity)
  if (!root || String(root['kind']).startsWith('memory_')) return null
  // One bounded recursive discovery query, not one full work-table scan per node.
  // No outer ORDER BY: PostgreSQL can stop the recursive producer at LIMIT 33.
  const candidates = await database.query(`WITH RECURSIVE tree AS (
    SELECT work.*,NULL::text AS trace_parent,0 AS trace_depth,ARRAY[work.id] AS trace_path
      FROM lingxios.agent_work_items work WHERE id=$1 AND tenant_id=$2 AND principal_id=$3
    UNION ALL SELECT child.*,parent.id,parent.trace_depth+1,parent.trace_path||child.id
      FROM tree parent JOIN lingxios.agent_work_items child ON child.meta->>'parentWorkId'=parent.id
        AND child.meta->'delegation'->>'parentWorkId'=parent.id
        AND child.tenant_id=parent.tenant_id AND child.principal_id=parent.principal_id
        AND child.thread_id IS NOT DISTINCT FROM parent.thread_id
        AND child.conversation->>'conversationId' IS NOT DISTINCT FROM parent.conversation->>'conversationId'
      WHERE parent.trace_depth<8 AND NOT child.id=ANY(parent.trace_path) AND left(child.kind,7)<>'memory_'
    ) SELECT tree.*,jsonb_array_length(steer_inputs)+1 AS request_version FROM tree LIMIT 33`,
  [identity.runId, identity.tenantId, identity.principalId])
  const records: Array<{ row: Record<string, unknown>; parent: string | null }> = [{ row: root, parent: null }]
  const admitted = new Set([identity.runId])
  let truncated = candidates.rows.length > 32
  for (const child of candidates.rows.slice(1,32).sort((a,b)=>Number(a['trace_depth'])-Number(b['trace_depth']))) {
    const runId = String(child['id']), parent = String(child['trace_parent'])
    if (!admitted.has(parent)) continue // A denied ancestor also hides its descendants.
    const childIdentity: RunIdentity = { ...identity, runId, agentId: String(child['agent_id']), sessionId: String(child['session_id']) }
    let row: Record<string, unknown> | null
    try { row = await readRunRecord(database, childIdentity) } catch (error) {
      if (error instanceof NoEffectError && error.code === 'forbidden') { truncated = true; continue }
      throw error // A failed read is unavailable, never a complete partial snapshot.
    }
    if (row) { records.push({ row, parent }); admitted.add(runId) }
    // At the depth boundary completeness cannot be asserted without another scan.
    if (Number(child['trace_depth']) === 8) truncated = true
  }
  const runIds = records.map(item => String(item.row['id']))
  // Only timing/identity fields are selected from internal diagnostic events.
  const events = await database.query(`SELECT run_id,seq,kind,stage,data->'_executionTrace' AS timing,
    data->>'callId' AS call_id,data->>'model' AS model,data->>'operation' AS operation,data->>'toolCallId' AS tool_call_id,
    data->>'name' AS name,data->'result'->>'status' AS tool_status
    FROM lingxios.agent_run_events WHERE run_id=ANY($1::text[]) AND tenant_id=$2
      AND kind=ANY($3::text[]) AND (expires_at IS NULL OR expires_at>NOW())
    ORDER BY run_id,seq LIMIT 2049`, [runIds, identity.tenantId, ['run.started', 'model.request.started', 'tool.started', 'tool.completed']])
  if (events.rows.length > 2048) truncated = true
  const calls = await database.query(`SELECT work_id,call_id,fence,observation->>'model' AS model,
    observation->'executionTiming' AS timing,observation->>'status' AS status,observation->>'operation' AS operation,
    observation->'usage' AS usage,observation->'cost' AS cost
    FROM lingxios.agent_model_budget_calls WHERE work_id=ANY($1::text[])
    ORDER BY work_id,call_id LIMIT 513`, [runIds])
  if (calls.rows.length > 512) truncated = true
  const sequences = await database.query(`SELECT run_id,MAX(seq) AS seq FROM lingxios.agent_run_events WHERE run_id=ANY($1::text[]) AND tenant_id=$2 GROUP BY run_id`, [runIds, identity.tenantId])
  const sequence = new Map(sequences.rows.map(row => [String(row['run_id']),Number(row['seq'])]))
  const spans: RunTraceSpan[] = []
  for (const { row, parent } of records) {
    const runId = String(row['id']), runEvents = events.rows.slice(0, 2048).filter(event => event['run_id'] === runId)
    const firstStart = object(runEvents.find(event => event['kind'] === 'run.started')?.['timing'])
    const startedAt = firstStart['fence'] === 1 ? number(firstStart['at']) : null
    const observedFinish = active(row['status']) ? null : time(row['finished_at'])
    const end = observedFinish !== null && (startedAt === null || observedFinish >= startedAt) ? observedFinish : null
    spans.push(finish({ spanId: rootId(runId), parentSpanId: parent ? rootId(parent) : null, runId,
      requestVersion: null, fence: null, attemptId: null,
      kind: 'agent', state: state(row['status']), startedAt, completedAt: end,
      seq: sequence.get(runId) ?? null, timingBasis: 'run-execution', ...(parent ? { childRunId: runId } : {}) }))
    const callRows = calls.rows.slice(0, 512).filter(call => call['work_id'] === runId)
    const modelStarts = new Map<string, Record<string, unknown>>()
    for (const event of runEvents) {
      if (event['kind'] === 'model.request.started' && string(event['call_id']) && !modelStarts.has(String(event['call_id']))) {
        modelStarts.set(String(event['call_id']), event)
      }
    }
    const callIds = new Set([...modelStarts.keys(), ...callRows.map(call => String(call['call_id']))])
    for (const callId of callIds) {
      const begin = modelStarts.get(callId), call = callRows.find(item => item['call_id'] === callId)
      const timing = object(begin?.['timing']), settlement = object(call?.['timing']), usage = object(call?.['usage']), cost = object(call?.['cost'])
      const pricing = object(cost['pricing']), measured = usage['available'] === true
      const observedEnd = number(settlement['completedAt']), start = number(timing['at'])
      const ended = observedEnd !== null && (start === null || observedEnd >= start) ? observedEnd : null
      const operation = modelOperation(call?.['operation']) ?? modelOperation(begin?.['operation'])
      spans.push(finish({ spanId: id('llm', runId, callId), parentSpanId: rootId(runId), runId,
        requestVersion: integer(timing['requestVersion']), fence: integer(timing['fence']) ?? integer(Number(call?.['fence'])),
        attemptId: callId, kind: 'llm', state: ended !== null ? settlement['cancelled'] === true ? 'cancelled'
          : call?.['status'] === 'succeeded' ? 'complete' : 'failed' : active(row['status']) && integer(timing['fence']) === Number(row['fence']) ? 'running' : 'unknown',
        seq: begin ? Number(begin['seq']) : null, startedAt: start, completedAt: ended, timingBasis: 'model-invocation', callId,
        model: string(call?.['model']) ?? string(begin?.['model']), usageAvailable: measured,...(operation ? { operation } : {}),
        inputTokens: measured ? number(usage['inputTokens']) : null, outputTokens: measured ? number(usage['outputTokens']) : null,
        costMicros: measured && cost['usage'] === 'measured' && (Number(pricing['inputMicrosPerMillion']) > 0 || Number(pricing['outputMicrosPerMillion']) > 0)
          ? number(cost['amountMicros']) : null }))
    }
    const tools = new Map<string, { begin?: Record<string, unknown>; end?: Record<string, unknown> }>()
    for (const event of runEvents) {
      const toolCallId = string(event['tool_call_id']), timing = object(event['timing'])
      if (!toolCallId || !event['kind']?.toString().startsWith('tool.')) continue
      const key = id('tool', runId, toolCallId, timing['fence'] ?? null, timing['requestVersion'] ?? null)
      const item = tools.get(key) ?? {}
      if (event['kind'] === 'tool.started') item.begin ??= event
      else item.end ??= event // A cached receipt replay is not another execution interval.
      tools.set(key, item)
    }
    for (const [spanId, { begin, end: result }] of tools) {
      const timing = object(begin?.['timing']), start = number(timing['at']), observedEnd = number(object(result?.['timing'])['at'])
      const ended = observedEnd !== null && (start === null || observedEnd >= start) ? observedEnd : null
      const toolStatus = result?.['tool_status']
      const toolState: TraceState = toolStatus === 'completed' ? 'complete' : toolStatus === 'awaiting-approval' ? 'waiting'
        : toolStatus === 'failed' ? 'failed' : result ? 'unknown'
        : row['status'] === 'leased' && integer(timing['fence']) === Number(row['fence']) ? 'running' : 'unknown'
      spans.push(finish({ spanId, parentSpanId: rootId(runId), runId, requestVersion: integer(timing['requestVersion']),
        fence: integer(timing['fence']), attemptId: string(timing['attemptId']), kind: 'tool', state: toolState,
        seq: result ? Number(result['seq']) : begin ? Number(begin['seq']) : null, startedAt: start, completedAt: ended, timingBasis: 'host-action',
        toolCallId: String(begin?.['tool_call_id'] ?? result?.['tool_call_id']), name: string(begin?.['name']) }))
    }
  }
  if (spans.length > 512) truncated = true
  // Reauthorize every admitted child after collecting data. A concurrent scope or
  // attempt change makes this snapshot unavailable instead of leaking an old grant
  // or mixing two executions. Read the root last so its revocation also wins.
  for (const { row } of [...records.slice(1), records[0]!]) {
    const current = await readRunRecord(database, { ...identity, runId: String(row['id']),
      agentId: String(row['agent_id']), sessionId: String(row['session_id']) })
    if (!current || ['request_version', 'fence', 'status'].some(key => current[key] !== row[key])) return null
  }
  const selected = spans.slice(0, 512)
  const snapshot = { version: 1 as const, seq: sequence.get(identity.runId) ?? 0, runId: identity.runId,
    requestVersion: Number(root['request_version']), fence: Number(root['fence']), rootSpanId: rootId(identity.runId),
    queuedAt: time(root['created_at']), origin: spans[0]?.startedAt ?? null, spans: selected, truncated }
  return { ...snapshot, revision: id(snapshot) }
}
