import type { PublicTextEndReason, PublicTextIdentity } from '../protocol/public-text.js'
import type { RunEvent } from '../protocol/types.js'
import { ModelDriverError } from '../errors.js'

/** A failed publication must never retry the provider or expose an uncommitted buffer. */
export class PublicTextPublicationError extends ModelDriverError {
  constructor(){super('public text could not be persisted',{kind:'provider',category:'unknown',finishReasons:[]})}
}
/** One provider attempt owns this bounded, append-only publication buffer. */
export class PublicTextWriter {
  private text=''
  private bytes=0
  private chunks=0
  private closed=false
  private failure:unknown
  private tail:Promise<void>=Promise.resolve()
  private timer:ReturnType<typeof setTimeout>|undefined
  constructor(private readonly identity:PublicTextIdentity,
    private readonly emit:(event:Omit<RunEvent,'runId'|'seq'>)=>Promise<unknown>,private readonly signal:AbortSignal){}
  async push(text:string):Promise<void>{
    this.signal.throwIfAborted()
    if(this.failure)throw this.failure
    if(this.closed)throw new PublicTextPublicationError()
    const bytes=Buffer.byteLength(text)
    if(this.bytes+bytes>200_000||Buffer.byteLength(this.text)+bytes>65_536)throw new PublicTextPublicationError()
    this.bytes+=bytes;this.text+=text
    if(!this.chunks||Buffer.byteLength(this.text)>=4096)await this.flush()
    else if(!this.timer)this.timer=setTimeout(()=>{this.timer=undefined;void this.flush().catch(()=>{})},50)
    await this.tail
  }
  private flush():Promise<void>{
    if(this.timer){clearTimeout(this.timer);this.timer=undefined}
    const pending=this.text;this.text=''
    if(!pending)return this.tail
    const task=this.tail.then(async()=>{
      if(this.failure)throw this.failure
      let chunk='',bytes=0
      const append=async()=>{
        if(!chunk)return
        this.signal.throwIfAborted()
        await this.emit({kind:'public.text.delta',stage:'delta',visibility:'user',data:{...this.identity,chunkIndex:this.chunks,text:chunk}})
        this.chunks++;chunk='';bytes=0
      }
      for(const point of pending){const size=Buffer.byteLength(point);if(bytes+size>4096)await append();chunk+=point;bytes+=size}
      await append()
    }).catch(()=>{this.failure=new PublicTextPublicationError();throw this.failure})
    this.tail=task
    void task.catch(()=>{})
    return task
  }
  async end(reason:PublicTextEndReason):Promise<void>{
    if(this.closed)return
    this.closed=true
    if(this.timer){clearTimeout(this.timer);this.timer=undefined}
    if(this.signal.aborted){this.text='';await this.tail.catch(()=>{});return}
    await this.flush()
    if(this.chunks)await this.emit({kind:'public.text.ended',stage:'completed',visibility:'user',data:{...this.identity,chunkCount:this.chunks,reason}})
  }
  dispose(){this.closed=true;this.text='';if(this.timer)clearTimeout(this.timer);this.timer=undefined}
}
