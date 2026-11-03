import type { PublicTextIdentity } from '../protocol/public-text.js'
import type { RunEvent } from '../protocol/types.js'

export interface PublicTextPublicationTiming {
  version:1
  clock:'monotonic'
  callId:string
  fence:number
  requestVersion:number
  revision:number
  /** Cumulative snapshots; consumers replace earlier revisions, never sum them. */
  publicationTotalMs:number
  publicationWaitMs:number
  publicationCount:number
  acknowledgedCount:number
  failure?:{stage:'operation'|'delta'|'end'|'seal';code:'persistence_rejected'|'cancelled'}
}


/** Fresh closed projection for public diagnostic readers; never copy event extensions. */
export function readPublicTextPublicationTiming(value:unknown):PublicTextPublicationTiming|undefined {
  try {
    if(!value||typeof value!=='object'||Reflect.get(value,'version')!==1||Reflect.get(value,'clock')!=='monotonic')return undefined
    const callId=Reflect.get(value,'callId')
    if(typeof callId!=='string'||!callId||callId.length>256)return undefined
    const positive=['fence','requestVersion','revision'] as const
    const counts=['publicationCount','acknowledgedCount'] as const
    for(const key of [...positive,...counts]){
      const number=Reflect.get(value,key)
      if(!Number.isSafeInteger(number)||Number(number)<(positive.includes(key as typeof positive[number])?1:0))return undefined
    }
    for(const key of ['publicationTotalMs','publicationWaitMs']){
      const number=Reflect.get(value,key)
      if(typeof number!=='number'||!Number.isFinite(number)||number<0||number>Number.MAX_SAFE_INTEGER)return undefined
    }
    if(Number(Reflect.get(value,'acknowledgedCount'))>Number(Reflect.get(value,'publicationCount')))return undefined
    const out:PublicTextPublicationTiming={version:1,clock:'monotonic',callId,
      fence:Number(Reflect.get(value,'fence')),requestVersion:Number(Reflect.get(value,'requestVersion')),revision:Number(Reflect.get(value,'revision')),
      publicationTotalMs:Number(Reflect.get(value,'publicationTotalMs')),publicationWaitMs:Number(Reflect.get(value,'publicationWaitMs')),
      publicationCount:Number(Reflect.get(value,'publicationCount')),acknowledgedCount:Number(Reflect.get(value,'acknowledgedCount'))}
    const failure=Reflect.get(value,'failure')
    if(failure!==undefined){
      if(!failure||typeof failure!=='object'||!['operation','delta','end','seal'].includes(Reflect.get(failure,'stage'))
        ||!['persistence_rejected','cancelled'].includes(Reflect.get(failure,'code')))return undefined
      out.failure={stage:Reflect.get(failure,'stage'),code:Reflect.get(failure,'code')} as NonNullable<PublicTextPublicationTiming['failure']>
    }
    return out
  }catch{return undefined}
}

export class PublicationTiming {
  private total=0
  private union=0
  private active=0
  private unionStart=0
  private count=0
  private acknowledged=0
  private revision=0
  private reportedCount=-1
  private failure:PublicTextPublicationTiming['failure']
  constructor(private readonly identity:PublicTextIdentity,private readonly signal:AbortSignal,
    private readonly report:((timing:PublicTextPublicationTiming)=>Promise<unknown>)|undefined,
    private readonly now=()=>performance.now()){}
  async measure<T>(event:Omit<RunEvent,'runId'|'seq'>,emit:()=>Promise<T>):Promise<T>{
    const began=this.now()
    if(this.active++===0)this.unionStart=began
    this.count++
    try {const result=await emit();this.acknowledged++;return result}
    catch(error){
      const stage=event.kind==='public.text.operation'?'operation':event.kind==='public.text.delta'?'delta':event.kind==='public.text.sealed'?'seal':'end'
      this.failure={stage,code:this.signal.aborted?'cancelled':'persistence_rejected'}
      throw error
    } finally {
      const ended=this.now();this.total+=ended-began
      if(--this.active===0)this.union+=ended-this.unionStart
    }
  }
  async flush():Promise<void>{
    if(!this.report||this.active||this.reportedCount===this.count)return
    this.reportedCount=this.count
    const value:PublicTextPublicationTiming={version:1,clock:'monotonic',callId:this.identity.attemptId,
      fence:this.identity.fence,requestVersion:this.identity.requestVersion,revision:++this.revision,
      publicationTotalMs:this.total,publicationWaitMs:this.union,publicationCount:this.count,acknowledgedCount:this.acknowledged,
      ...(this.failure?{failure:{...this.failure}}:{})}
    // Observation is best effort. Its failure must not replace the original
    // publication error, invent an ACK, or trigger a second model invocation.
    await this.report(value).catch(()=>{})
  }
}
