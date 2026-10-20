import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { it } from 'node:test'
import { memoryFixture, content, identity, scope } from './memory-fixture.js'
import { withTransaction } from '../src/control-plane/pg-store.js'
import { executeMemorySynthesis, type MemoryBatch } from '../src/memory/synthesis.js'
import { fitMemorySnapshot, snapshotMemories } from '../src/memory/context.js'

// Failures recorded before implementation in docs/issue-216-failure-model.md.
it('pages long Chinese source material completely and durably fences page replay and forgetting',async()=>{
  const f=await memoryFixture()
  try {
    const text='开头材料。'.repeat(1500)+'中部偏好：先给图表。'+'课程材料。'.repeat(1500)+'末尾目标：完成线性代数项目。'
    const source=await f.source({text})
    let {job}=await f.reflection(); assert.ok(job)
    const invoke=(method:string,args:Record<string,unknown>)=>withTransaction(f.pool,db=>executeMemorySynthesis(db,job!,method,args,f.options))
    let parts='',pages=0
    for (;;) {
      const batch=await invoke('load',{}) as MemoryBatch|null
      if (!batch) break
      assert.ok(Buffer.byteLength(JSON.stringify(batch.evidence))<18000)
      assert.ok(batch.evidence.every(item=>item.segment.next-item.segment.start<=2),'long sources use at most two segments per proposal')
      parts+=batch.evidence.map(item=>item.userText).join('')
      await invoke('apply',{changes:[],conflicts:[],approved:true,confidence:1})
      assert.ok(++pages<100)
      await f.store.complete(job!.id,job!.fence,createHash('sha256').update(job!.leaseToken).digest('hex'),{status:'completed'})
      const next=await f.reflection();job=next.job
      if (!job) break
    }
    assert.match(parts,/中部偏好：先给图表/)
    assert.match(parts,/末尾目标：完成线性代数项目/)
    assert.ok(pages>1)
    assert.equal((await f.db.query<{status:string}>('SELECT status FROM lingxios.agent_memory_evidence_scopes WHERE source_run_id=$1',[source.work.id])).rows[0]?.status,'processed')
    await f.api.forget(identity,scope)
        assert.equal((await f.db.query<{n:number}>('SELECT count(*)::int AS n FROM lingxios.agent_memory_evidence_segments')).rows[0]?.n,0)
  } finally { await f.close() }
})

it('reserves context space for relevant details and records traceable oversized core fragments',async()=>{
  const f=await memoryFixture()
  try {
    const docs=(await f.api.initialize(identity,{scope,documents:[content('简短偏好。','core.md','core'),
      content('大段档案。'.repeat(900),'large.md','core'),content('相关课程详细信息。','detail.md')],idempotencyKey:'budget',sourceRef:'settings'})).documents
    const snapshot=snapshotMemories({status:'available',core:docs.slice(0,2),directory:Array.from({length:30},()=>docs[2]!),
      recalled:[{...docs[2]!,excerpt:docs[2]!.body,score:1}],strategies:[],
      omitted:{core:0,directory:0,recalled:0,strategies:0},budget:{ratio:.08,maxTokens:8000,
        allocation:{core:.5,directory:.1,recalled:.35,strategies:.05}},retrieval:['hybrid']})
    const fitted=fitMemorySnapshot(snapshot,100000)
    assert.ok(fitted.core.some(item=>item.id===docs[0]!.id))
    assert.ok(fitted.core.some(item=>item.id===docs[1]!.id && item.contextFragment))
    assert.equal(fitted.recalled.length,1)
    assert.ok(fitted.omitted.directory>0)
    assert.ok(Buffer.byteLength(JSON.stringify(fitted))<=8000)
  } finally { await f.close() }
})
