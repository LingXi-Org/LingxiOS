import type { SessionRecord } from '../protocol/types.js'
import { appendRequestHistory, isCurrentHistory } from '../context/request-history.js'

/** A terminal wait cancels the unstarted remainder of this model tool batch.
 * A human reply starts a fresh turn; old arguments must never execute then. */
export function closePendingCallsForWait(session: SessionRecord): void {
  if (!session.request) return
  const workId = session.request.workId
  const pending = new Set<string>()
  for (const item of session.history) {
    if (!isCurrentHistory(item, workId)) continue
    if ('type' in item && item.type === 'function_call') pending.add(item.callId)
    if ('type' in item && item.type === 'function_call_output') pending.delete(item.callId)
  }
  for (const callId of pending) appendRequestHistory(session, workId, { type: 'function_call_output', callId,
    output: JSON.stringify({ ok: false, executionState: 'not_started', code: 'input_wait',
      error: 'Not started because a preceding action requested input. Reconsider after the human reply.' }) })
}
