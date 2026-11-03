/** Observed local stages. Nested durations must never be summed as provider time. */
export interface ModelStageTimings {
  version: 1
  clock: 'monotonic'
  providerTime: 'unavailable'
  totalMs?: number
  modelPermitWaitMs?: number
  httpRequestCount?: number
  httpToHeadersMs?: number
  httpToFirstContentMs?: number
  httpToFirstCompleteToolCallMs?: number
  observedStreamMs?: number
  streamCompleted?: boolean
  finalProtocolValidationMs?: number
  outputCallbackTotalMs?: number
  outputCallbackWaitMs?: number
  outputCallbackCount?: number
}
export type ModelTimingUpdate = Partial<Omit<ModelStageTimings,'version'|'clock'|'providerTime'|'totalMs'>>
const numeric = ['totalMs','modelPermitWaitMs','httpRequestCount','httpToHeadersMs','httpToFirstContentMs',
  'httpToFirstCompleteToolCallMs','observedStreamMs','finalProtocolValidationMs','outputCallbackTotalMs',
  'outputCallbackWaitMs','outputCallbackCount'] as const
export function readModelStageTimings(value: unknown): ModelStageTimings | undefined {
  try {
  if (!value || typeof value !== 'object' || Reflect.get(value,'version') !== 1
    || Reflect.get(value,'clock') !== 'monotonic' || Reflect.get(value,'providerTime') !== 'unavailable') return undefined
  const out: ModelStageTimings = {version:1,clock:'monotonic',providerTime:'unavailable'}
  for (const key of numeric) {
    const candidate=Reflect.get(value,key)
    if (typeof candidate==='number' && Number.isFinite(candidate) && candidate>=0 && candidate<=Number.MAX_SAFE_INTEGER
      && (!key.endsWith('Count') || Number.isSafeInteger(candidate))) out[key]=candidate
  }
  if (typeof Reflect.get(value,'streamCompleted')==='boolean') out.streamCompleted=Reflect.get(value,'streamCompleted') as boolean
  return out
  } catch { return undefined }
}

/** Tracks cumulative callbacks and their union separately, including failed waits. */
export class ModelTimingCollector {
  private values: ModelStageTimings={version:1,clock:'monotonic',providerTime:'unavailable'}
  private active=0
  private unionStart=0
  constructor(private readonly now=()=>performance.now()) {}
  update=(value:ModelTimingUpdate)=>{
    this.values=readModelStageTimings({...this.values,...value})!
  }
  callback<T>(operation:()=>T):T {
    const began=this.now()
    if(this.active++===0)this.unionStart=began
    this.values.outputCallbackCount=(this.values.outputCallbackCount??0)+1
    const finish=()=>{
      const ended=this.now()
      this.values.outputCallbackTotalMs=(this.values.outputCallbackTotalMs??0)+ended-began
      if(--this.active===0)this.values.outputCallbackWaitMs=(this.values.outputCallbackWaitMs??0)+ended-this.unionStart
    }
    try {
      const result=operation()
      if(result && typeof (result as {then?:unknown}).then==='function')return Promise.resolve(result).finally(finish) as T
      finish();return result
    } catch(error){finish();throw error}
  }
  snapshot(totalMs?:number):ModelStageTimings {
    const result={...this.values,...(totalMs===undefined?{}:{totalMs})}
    // Cancellation can settle while a non-cooperative callback is still pending.
    if(this.active)result.outputCallbackWaitMs=(result.outputCallbackWaitMs??0)+this.now()-this.unionStart
    return result
  }
}

/** One driver's final HTTP attempt; executionModel disables internal retries. */
export class DriverTiming {
  private httpBegan:number|undefined
  private validationBegan:number|undefined
  private values:ModelTimingUpdate={}
  constructor(private readonly notify:((update:ModelTimingUpdate)=>void)|undefined,private readonly now=()=>performance.now()){}
  request(){this.httpBegan=this.now();this.values={httpRequestCount:(this.values.httpRequestCount??0)+1}}
  headers(){if(this.httpBegan!==undefined)this.values.httpToHeadersMs=this.now()-this.httpBegan}
  content(){if(this.httpBegan!==undefined)this.values.httpToFirstContentMs??=this.now()-this.httpBegan}
  tool(call:{id:string;name:string;arguments:string}){
    if(this.values.httpToFirstCompleteToolCallMs!==undefined||!call.id||!call.name||!call.arguments.trimEnd().endsWith('}'))return
    try {const value:unknown=JSON.parse(call.arguments);if(value&&typeof value==='object'&&!Array.isArray(value)&&this.httpBegan!==undefined)this.values.httpToFirstCompleteToolCallMs=this.now()-this.httpBegan}catch{}
  }
  stream(completed:boolean){if(this.httpBegan!==undefined)this.values.observedStreamMs=this.now()-this.httpBegan;this.values.streamCompleted=completed}
  validation(){this.validationBegan=this.now()}
  finish(){if(this.validationBegan!==undefined)this.values.finalProtocolValidationMs=this.now()-this.validationBegan;this.notify?.({...this.values})}
}
