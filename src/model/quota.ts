import type { ModelDriver } from './driver.js'
import { ResourceQuota, type ResourcePriority } from '../resource-quota.js'

export function limitModel(source: ModelDriver, quota: ResourceQuota, background = new Set<AbortController>()): ModelDriver {
  return new Proxy(source, { get(target, property) {
    if (property === 'deferredAdmission') return true
    if (property === 'singleAttempt') return () => limitModel(target.singleAttempt?.() ?? target, quota, background)
    const value = Reflect.get(target, property, target) as unknown
    if (['run', 'structured', 'compact'].includes(String(property))) {
      return (request: { signal?: AbortSignal; admission?: ResourcePriority; interruptible?: boolean; beforeProvider?: () => void | Promise<void> }) => {
        const priority = request.admission ?? (property === 'compact' ? 'background' : 'foreground')
        // At capacity one there is no spare slot: interrupt cancellable auxiliary generation, never fake a release.
        if (priority === 'foreground' && quota.capacity === 1) for (const stop of background) stop.abort(new Error('foreground model admission'))
        const stop = new AbortController(), signal = AbortSignal.any([stop.signal, ...request.signal ? [request.signal] : []])
        return quota.run(() => {
          if (priority === 'background' && property === 'compact' && request.interruptible === true) background.add(stop)
          const finished = () => { background.delete(stop) }
          try {
            const start=()=>{
              signal.throwIfAborted()
              const {beforeProvider:_gate,...input}=request
              return Reflect.apply(value as Function,target,[{...target.deferredAdmission ? request : input,signal}]) as Promise<unknown>
            }
            const gate=target.deferredAdmission ? undefined : request.beforeProvider?.()
            const pending = gate ? gate.then(start) : start()
            void pending.then(finished, finished)
            return pending
          } catch (error) { finished(); throw error }
        }, signal, priority)
      }
    }
    return typeof value === 'function' ? value.bind(target) : value
  } })
}
