import type { HostActionResult } from './types.js'

/** A successful native action that has asked the user for blocking input. */
export interface UserInputWaitResult extends HostActionResult {
  ok: true
  executionState: 'succeeded'
  directive: { type: 'defer'; reason: 'user'; data: { question: string } }
}

export function isInputQuestion(question: unknown): question is string {
  return typeof question === 'string' && question.trim().length > 0 && question.length <= 4000
}

/** Return after the authorized tool has durably created its question/card. The
 * runtime records this receipt and parks the current request without another turn.
 * Only non-read tools may wait (transaction, idempotent or uncertain). Read
 * tools run concurrently and returning a terminal defer is a contract error.
 * Resume with continueInput using the same identity and requestVersion. */
export function userInputWait(question: string, value?: unknown): UserInputWaitResult {
  if (!isInputQuestion(question)) throw new Error('input question must be a non-empty string of at most 4000 characters')
  return { ok: true, executionState: 'succeeded', ...(value === undefined ? {} : { value }),
    directive: { type: 'defer', reason: 'user', data: { question } } }
}

/** Only durable successful receipts authorize input waits; model output does not. */
export function inputWaitQuestion(result: HostActionResult | null | undefined): string | undefined {
  if (result?.ok !== true || result.approval !== undefined || (result.executionState !== undefined && result.executionState !== 'succeeded')
    || result.directive?.type !== 'defer' || result.directive.reason !== 'user') return undefined
  const question = result.directive.data?.['question']
  return isInputQuestion(question) ? question : undefined
}
