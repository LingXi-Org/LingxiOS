/** Trusted invocation metadata only; never classify prompt or answer text. */
export const MODEL_OPERATIONS = ['generation', 'correction', 'content-review', 'compaction',
  'memory-synthesis', 'approval-explanation', 'embedding', 'structured'] as const
export type ModelOperation = typeof MODEL_OPERATIONS[number]
export function modelOperation(value: unknown): ModelOperation | undefined {
  return typeof value === 'string' && MODEL_OPERATIONS.includes(value as ModelOperation) ? value as ModelOperation : undefined
}
