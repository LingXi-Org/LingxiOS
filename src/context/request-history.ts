import type { ModelItem, SessionRecord } from '../protocol/types.js'
import { contextItem } from './compiler.js'
import type { ExecutionStep } from '../control-plane/steps.js'

export const historyBoundary = (session: SessionRecord) => session.historyBoundary !== undefined ? session.historyBoundary
  : session.request ? { workId: session.request.workId, requestVersion: session.request.revisions.length + 1 } : null

export const isCurrentHistory = (item: ModelItem, workId: string) => item.historySource?.workId === workId

/** Newly created runtime records have an exact origin. Provider-supplied extra
 * fields cannot choose it. Persisted business payloads stay byte-identical. */
export function appendRequestHistory(session: SessionRecord, workId: string, ...items: ModelItem[]): void {
  const historySource = { workId, requestVersion: session.request?.workId === workId ? session.request.revisions.length + 1 : 1 }
  session.history.push(...items.map(item => ({ ...item, historySource })))
}

/** Called before recovery; current-work checkpoints may prove legacy calls.
 * A raw session boundary never proves every mixed historical item's origin. */
export function archivePriorRequest(session: SessionRecord, workId: string, steps: readonly ExecutionStep[] = []): void {
  const provenCalls = new Map<string, NonNullable<ModelItem['historySource']>>()
  session.history = session.history.map(item => {
    let source = item.historySource?.workId ? item.historySource : undefined
    if ('type' in item && item.type === 'function_call') {
      const step = steps.find(step => step.id === (item.stepId ?? item.callId) && step.kind === item.name
        && step.input['callId'] === item.callId
        && (item.name === 'ipython' ? typeof step.input['code'] === 'string'
          && JSON.stringify({ code: step.input['code'] }) === item.arguments : step.input['arguments'] === item.arguments))
      source ??= step ? { workId, requestVersion: step.requestVersion } : undefined
      provenCalls.set(item.callId, source ?? { workId: null, requestVersion: null })
    } else if ('type' in item) {
      const pending = provenCalls.get(item.callId)
      if (!source) { source = pending; provenCalls.delete(item.callId) }
      else if (pending?.workId === source.workId && pending.requestVersion === source.requestVersion) provenCalls.delete(item.callId)
    }
    // A raw boundary is not origin proof. Associate an untagged output only with
    // its preceding call, never a later work that reused the provider call ID.
    return { ...item, historySource: source ?? { workId: null, requestVersion: null } }
  })
}

/** Apply memory authorization first. This is a model-view projection, never an
 * action result, a completion claim, or a change to the durable original. */
export function projectRequestHistory(items: readonly ModelItem[], workId?: string): ModelItem[] {
  const current: ModelItem[] = [], archived: ModelItem[] = []
  for (const item of items) {
    if (!item.historySource || workId !== undefined && isCurrentHistory(item, workId)) {
      const { historySource: _source, ...record } = item
      current.push(record); continue
    }
    const { historySource, memorySources, ...record } = item
    archived.push({ ...contextItem({ source: `history:execution:${historySource.workId ?? 'unknown'}`,
      version: historySource.requestVersion === null ? 'unknown' : String(historySource.requestVersion),
      trust: 'observation', truncated: false,
      content: JSON.stringify({ sourceWorkId: historySource.workId, sourceRequestVersion: historySource.requestVersion,
        context: 'Previous-request record, not a current tool call or delivery obligation. Completion is not established here. Preserve recorded effects; reconcile unknown effects before acting.', record }) }),
      ...(memorySources ? { memorySources } : {}) })
  }
  // A resumed work's native call/output pair must remain contiguous even when
  // another work contributed observations while it was waiting.
  return [...archived, ...current]
}
