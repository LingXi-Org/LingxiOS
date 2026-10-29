import { isDeepStrictEqual } from 'node:util'
import type { ExecutionStep, StepStore } from '../src/control-plane/steps.js'
import type { StoreLeaseProof } from '../src/control-plane/stores.js'

export class MemoryStepStore implements StepStore {
  private readonly entries = new Map<string, ExecutionStep>()
  async save(proof: StoreLeaseProof, step: ExecutionStep) {
    const key = JSON.stringify([proof.workId, step.id]), prior = this.entries.get(key)
    if (prior && (!isDeepStrictEqual(prior.input, step.input) || prior.kind !== step.kind || prior.requestVersion !== step.requestVersion
      || prior.output !== undefined && !isDeepStrictEqual(prior, step))) throw new Error('step identity changed')
    this.entries.set(key, structuredClone(step))
  }
  async get(workId: string, id: string, version: number) {
    const step = this.entries.get(JSON.stringify([workId, id]))
    return step?.requestVersion === version ? structuredClone(step) : null
  }
  async list(workId: string, version?: number) {
    return [...this.entries].filter(([key, step]) => JSON.parse(key)[0] === workId && step.kind !== 'runtime.action_trace' && (version === undefined || step.requestVersion === version))
      .map(([, step]) => structuredClone(step))
  }
}
