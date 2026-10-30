// Opt-in bounded observation, not a production-budget acceptance run.
// Copy this file and issue560-probe-verdict.ts to Loop server/src/__integration__.
// Use only an isolated test DB and the already-authorized provider configuration.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { env } from '../env.js'
import { pool } from '../db/pool.js'
import { receiveAgentRequest } from '../agent-runtime/receive.js'
import { lingxiOSControl, startLingxiOSWorker } from '../agent-runtime/runtime.js'
import { visualizeReferences } from '../agent-runtime/visualize-projection.js'
import { readAuthorizedVisualizeSnapshot } from '../im/visualize.js'
import { createNativeMessage, nativeText } from '../im/message-types.js'
import { DEFAULT_AGENT_CAPABILITIES } from '../../../src/lib/agentCapabilities.js'
import { ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, seedUserMembership, teardownAll } from './_helpers.js'
import { installRecordingWukong } from './_recording-wukong.js'
import { issue560ProbeVerdict } from './issue560-probe-verdict.js'

const probeCallLimit=6
const protocolCodes=new Set(['native_envelope_invalid','terminal_outcome_required','public_text_invalid','public_text_incomplete','public_text_answer_required','public_answer_first_required','tool_identity_invalid','response_empty'])
const protocolDetails=new Set(['json_syntax','duplicate_field','unknown_field','answer_type','commentary_type','operation_invalid','outcome_invalid','root_invalid','unicode_invalid','text_regression','depth_limit','size_limit','parser_closed','identity_changed','tool_name_unknown','tool_id_invalid','tool_id_duplicate','tool_index_invalid','tool_batch_invalid','tool_metadata_invalid','mixed_output_channels','terminal_with_business'])
const finishReasons=new Set(['tool_calls','stop','length','content_filter'])
test('bounded real-model observation requires verified artifact delivery to pass', {skip:process.env.LINGXIOS_ISSUE560_PROBE!=='1',timeout:250000}, async()=>{
  await ensureSchemaOnce();await resetAllTables()
  const im=await installRecordingWukong(),originalFetch=globalThis.fetch
  let worker:Awaited<ReturnType<typeof startLingxiOSWorker>>|undefined
  const requests:Array<{ordinal:number;visibleToolNames:string[];phaseHint:string}>=[]
  const providerOrigin=new URL(env.OPENAI_BASE_URL).origin
  globalThis.fetch=async(input,init)=>{
    const url=new URL(input instanceof Request?input.url:String(input))
    if(url.origin===providerOrigin&&url.pathname.endsWith('/chat/completions')){
      const payload=JSON.parse(String(init?.body??'{}'))
      // Only trusted schema names and fixed phase labels leave this in-memory request.
      const visibleToolNames=(payload.tools??[]).map((tool:{function:{name:string}})=>tool.function.name)
      const content=(payload.messages??[]).map((message:{content?:unknown})=>typeof message.content==='string'?message.content:'').join('\n')
      requests.push({ordinal:requests.length+1,visibleToolNames,phaseHint:content.includes('Current workflow phase: the explanation is durably recorded.')?'provided':content.includes('Current workflow phase: explain the selected request facts.')?'pending':'none'})
    }
    return originalFetch(input,init)
  }
  try{
    const {companyId,projectId,agentId}=await seedCompanyWithAgent()
    const userId='test-owner',channelId='issue560-probe',members=[userId,agentId],clientMsgNo='probe-question'
    await seedUserMembership(userId,companyId)
    await pool.query('UPDATE participants SET capabilities=$1 WHERE company_id=$2 AND id=$3',[JSON.stringify(DEFAULT_AGENT_CAPABILITIES),companyId,agentId])
    await pool.query("INSERT INTO conversations(id,company_id,project_id,kind,title,members) VALUES($1,$2,$3,'group','Bounded synthetic request',$4::jsonb)",[channelId,companyId,projectId,JSON.stringify(members)])
    await pool.query('INSERT INTO im_channel_bindings(channel_id,company_id,profile) VALUES($1,$2,$3::jsonb)',[channelId,companyId,JSON.stringify({channelType:2,members})])
    process.env.LINGXIOS_SERVICE_TOKEN='synthetic-issue560-probe-token'
    process.env.AGENT_OS_WORKER_PORT='52994'
    process.env.AGENT_OS_MAX_MODEL_CALLS=String(probeCallLimit)
    process.env.AGENT_OS_MAX_WORK_MS='180000'
    const api=await lingxiOSControl(),port=await api.listenControlPlane({serviceToken:process.env.LINGXIOS_SERVICE_TOKEN,port:0})
    process.env.LINGXIOS_CONTROL_URL=`http://127.0.0.1:${port}`
    worker=await startLingxiOSWorker()
    const text='请用中文讲解 attention 工作流程，简要解释 Q、K、V 与 softmax，并创建一个可以切换查询位置的交互视图，保存为 attention-flow.html。请通过可用的 visualize 工具实际保存并验证，完成后给出已交付作品引用。'
    im.messages.push({channelId,channelType:2,fromUid:userId,messageId:clientMsgNo,clientMsgNo,messageSeq:1,timestamp:Date.now()/1000,payload:createNativeMessage({id:clientMsgNo,role:'user',content:[{type:'text',text}],custom:{mentionedIds:[agentId]}})})
    const result=await receiveAgentRequest({companyId,agentId,channelId,clientMsgNo});assert.ok('runs' in result)
    const run=result.runs[0];assert.ok(run)
    const timeout=AbortSignal.timeout(220000);let state=await api.readRunState(run)
    while(state&&(['queued','leased','waiting'].includes(state.run.status)||state.delivery==='pending')){timeout.throwIfAborted();await delay(100);state=await api.readRunState(run)}
    const rows=(await pool.query("SELECT kind,data FROM lingxios.agent_run_events WHERE run_id=$1 AND kind IN ('model.completed','model.failed','run.failed','response.continued','tool.started') ORDER BY seq",[run.runId])).rows
    const knownTools=new Set(requests.flatMap(request=>request.visibleToolNames.map(name=>name.replace('__','.'))))
    const events=rows.map(row=>{const diagnostics=row.data.modelDiagnostics??row.data.diagnostics,budget=row.data.budgetLimit
      return {kind:row.kind,finishReasons:(diagnostics?.finishReasons??[]).filter((value:string)=>finishReasons.has(value)),
        protocolCode:protocolCodes.has(diagnostics?.protocolCode)?diagnostics.protocolCode:null,protocolDetail:protocolDetails.has(diagnostics?.protocolDetail)?diagnostics.protocolDetail:null,
        action:knownTools.has(row.data.name)?row.data.name:null,continuation:row.data.reason==='intermediate_outcome_null'?'intermediate_outcome_null':null,
        budgetLimit:budget?.code==='budget_limit'&&['calls','tokens','cost','deadline','reservation'].includes(budget.dimension)?{code:'budget_limit',dimension:budget.dimension}:null}}
    )
    const calls=(await pool.query('SELECT count(*)::int AS n FROM llm_calls WHERE company_id=$1 AND run_id=$2',[companyId,run.runId])).rows[0].n
    const docs=(await pool.query('SELECT path FROM im_visualize_documents WHERE run_id=$1',[run.runId])).rows
    const body=im.messages.filter(message=>message.channelId===channelId&&message.fromUid===agentId).map(message=>nativeText(message.payload)).join('\n')
    const references=visualizeReferences(body)
    let authorizedReadback=false
    if(docs.length===1){const document=await readAuthorizedVisualizeSnapshot({companyId,channelId,userId,path:docs[0].path})
      authorizedReadback=!!document.html&&document.run_id===run.runId&&createHash('sha256').update(document.html).digest('hex')===document.source_hash}
    const skillDelivered=(await pool.query("SELECT 1 FROM lingxios.agent_skill_activations WHERE work_id=$1 AND resolution='delivered'",[run.runId])).rowCount!>0
    const referenceDelivered=docs.length===1&&references.some(reference=>reference.reference.path===docs[0].path)&&skillDelivered&&state?.delivery==='delivered'
    const verdict=issue560ProbeVerdict({saved:docs.length===1,authorizedReadback,referenceDelivered,accepted:state?.run.goalOutcome?.status==='satisfied',protocolRejected:rows.some(row=>row.data.modelDiagnostics?.kind==='protocol'),calls,probeCallLimit,budgetLimit:events.find(event=>event.budgetLimit)?.budgetLimit})
    console.info(JSON.stringify({qualification:'bounded-observation',probeCallLimit,productionBudgetEquivalent:false,requests,events,calls,saved:docs.length,authorizedReadback,referenceDelivered,verdict,browserValidation:false}))
    assert.equal(verdict,'delivered',`Bounded observation: ${verdict}; no production acceptance or eventual success is implied.`)
  }finally{globalThis.fetch=originalFetch;await worker?.stop();await teardownAll();await im.close()}
})
