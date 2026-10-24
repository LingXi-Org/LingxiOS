import { ModelDriverError } from '../errors.js'
import type { PublicTextOperation } from '../protocol/answer-segments.js'
import { snapshotPublicTextOperation } from '../protocol/answer-segments.js'
import type { ExecutionStep } from '../control-plane/steps.js'

/** A runtime-requested repair revises its sealed candidate. Ordinary tool
 * continuations keep their model-declared append/replace operation. */
export function answerCorrectionOperation(correction: boolean, activeSources: readonly string[]): PublicTextOperation | undefined {
  return correction && activeSources.length ? { kind: 'replace', supersedes: [...activeSources] } : undefined
}

/** A durable repair intent survives a lost acknowledgement. A replacement seal
 * changes active source IDs, so it retires the intent without a second write. */
export function restoreAnswerCorrection(steps: readonly ExecutionStep[] | undefined, requestVersion: number, activeSources: readonly string[]): PublicTextOperation | undefined {
  const step = steps?.findLast(item => item.kind === 'runtime.answer_correction' && item.requestVersion === requestVersion)
  if (!step) return undefined
  const operation = snapshotPublicTextOperation(step.input['operation'])
  return operation.kind === 'replace' && operation.supersedes.length === activeSources.length
    && operation.supersedes.every((source, index) => source === activeSources[index]) ? operation : undefined
}

/** Called before the first substantive byte and again for non-streaming drivers.
 * Never rewrite a provider operation or compare answer text to guess intent. */
export function assertAnswerCorrection(actual: PublicTextOperation | undefined, required: PublicTextOperation | undefined): void {
  if (!required) return
  if (actual?.kind !== 'replace' || actual.supersedes.length !== required.supersedes.length
    || actual.supersedes.some((source, index) => source !== required.supersedes[index])) {
    throw new ModelDriverError('A corrected answer must explicitly replace the sealed candidate sources', {
      kind: 'protocol', category: 'protocol', protocolCode: 'public_text_invalid', finishReasons: [],
    })
  }
}
