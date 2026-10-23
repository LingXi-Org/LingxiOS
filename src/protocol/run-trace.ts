export type TraceState = 'running' | 'waiting' | 'complete' | 'partial' | 'blocked' | 'cancelled' | 'failed' | 'unknown'
export interface RunTraceSpan {
  spanId: string; parentSpanId: string | null; runId: string
  requestVersion: number | null; fence: number | null; attemptId: string | null
  kind: 'agent' | 'llm' | 'tool'; state: TraceState
  startedAt: number | null; completedAt: number | null
  timingBasis: 'run-execution' | 'model-invocation' | 'host-action' | 'python-execution'
  seq: number | null; revision: string
  childRunId?: string
  callId?: string; model?: string | null; usageAvailable?: boolean
  operation?: import('../model/operation.js').ModelOperation
  inputTokens?: number | null; outputTokens?: number | null; costMicros?: number | null
  toolCallId?: string; stepId?: string; name?: string | null
}
export interface RunTraceSnapshot {
  version: 1; seq: number; revision: string; runId: string; requestVersion: number; fence: number; rootSpanId: string; queuedAt: number | null
  origin: number | null; spans: RunTraceSpan[]; truncated: boolean
}

const integer = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
const string = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && value.length <= 2000 ? value : null

/** Fenced control-plane event metadata. Captured and committed before execution,
 * never from observer/subscriber time. Raw event data is not a public trace. */
export function executionTraceMetadata(kind: string, data: Record<string, unknown>, requestVersion: number, fence: number) {
  const python = ['ipython.started', 'ipython.completed', 'ipython.failed', 'ipython.timeout', 'ipython.cancelled', 'ipython.waiting'].includes(kind)
    && data['name'] === 'ipython'
  if (!python && !['run.started', 'tool.started', 'tool.completed', 'model.request.started'].includes(kind)) return undefined
  const suppliedVersion = integer(data['requestVersion'])
  return { version: 1, at: Date.now(), requestVersion: kind === 'run.started' ? requestVersion
    : suppliedVersion !== null && suppliedVersion <= requestVersion ? suppliedVersion : null, fence,
    attemptId: kind === 'model.request.started' ? string(data['callId']) : string(data['attemptId']) }
}
