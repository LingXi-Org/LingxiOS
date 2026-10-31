// Opt-in SDK-only qualification. No production DB, product dependency override,
// prompts, reasoning or credential values are written to evidence.
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,readFile,readdir,writeFile,rm} from 'node:fs/promises'
import {resolve,join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {publicModelDiagnostics} from '../dist/src/model/diagnostics.js'
import {PGlite} from '@electric-sql/pglite'
import {createLingxiOS,packageResources,skillIndex,DefaultRuntimePolicy} from '../dist/src/index.js'
import {createWorker} from '../dist/src/worker/index.js'
if(process.env.LINGXIOS_LIVE_NATIVE_SELECTION!=='1')throw Error('explicit live probe opt-in required')
assert.equal(process.env.OPENAI_MODEL,'deepseek-ai/DeepSeek-V4.1-Flash')
assert.equal(new URL(process.env.OPENAI_BASE_URL).hostname,'api.siliconflow.cn')
const loop=resolve(process.env.LINGXILOOP_SOURCE??'/workspace/LingxiLoop')
const upstream=join(loop,'third_party/baoyu-design/upstream/claude-design')
const references=(await readdir(join(upstream,'artifact-type/reference'))).sort()
const root=await mkdtemp(join(tmpdir(),'issue593-sdk-artboard-')),files=new Map()
const hash=text=>createHash('sha256').update(text).digest('hex')
const initial={v:3,createdOnFiles:{v:1,at:new Date().toISOString()},title:'FlashAttention',launch:{view:'canvas'},pages:[],boards:{},order:[],notes:{},designSystems:[]}
files.set('project/canvas.json',JSON.stringify(initial));await mkdir(join(root,'project'));await writeFile(join(root,'project/canvas.json'),files.get('project/canvas.json'))
const pathPattern='^project/[A-Za-z0-9][A-Za-z0-9._/-]*$'
const scopedPath=path=>{assert.equal(typeof path,'string');assert.match(path,new RegExp(pathPattern));assert.ok(!path.includes('..')&&!path.includes('\\'));return path}
const authorize=async context=>{assert.equal(context.work.tenantId,'sdk-probe');assert.equal(context.work.principalId,'probe-human')}
const definition=(method,properties,required,execute,effect='read')=>({name:'design__'+method,action:'design.'+method,description:({current:'List actual canvas files and hashes.',read_file:'Read only a file listed by current; do not guess paths.',read_reference:'Read an actual format reference. Start with format.md. Valid pages: '+references.join(', '),write_files:'Write the canvas index and one artboard per call; use ifMatch from actual reads. Finish all indexed boards before check.',check:'Run the actual upstream format checker; fix every issue until problems is 0.'})[method],parameters:{type:'object',properties,required,additionalProperties:false},effect,approval:false,parse:value=>value,authorize,execute})
const tools=[
 definition('current',{},[],async()=>({ok:true,value:{files:Object.fromEntries([...files].map(([path,text])=>[path,{sha256:hash(text)}]))}})),
 definition('read_file',{path:{type:'string',pattern:pathPattern}},['path'],async(_context,{path})=>{scopedPath(path);assert.ok(files.has(path),'unlisted file');return{ok:true,value:{path,text:files.get(path),sha256:hash(files.get(path))}}}),
 definition('read_reference',{page:{type:'string',enum:references}},['page'],async(_context,{page})=>({ok:true,value:{page,text:await readFile(join(upstream,'artifact-type/reference',page),'utf8')}})),
 definition('write_files',{files:{type:'object',minProperties:1,maxProperties:32,additionalProperties:{type:'object',properties:{content:{type:'string'},ifMatch:{type:['string','null']}},required:['content'],additionalProperties:false}}},['files'],async(_context,input)=>{
  for(const [path,entry]of Object.entries(input.files)){scopedPath(path);if(entry.ifMatch!==undefined)assert.equal(files.has(path)?hash(files.get(path)):null,entry.ifMatch)}
  for(const [path,entry]of Object.entries(input.files)){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),entry.content);files.set(path,entry.content)}
  return{ok:true,value:{shas:Object.fromEntries(Object.keys(input.files).map(path=>[path,hash(files.get(path))]))}}
 },'idempotent'),
 definition('check',{},[],async()=>{const checked=spawnSync(process.execPath,[join(upstream,'scripts/artifact.mjs'),'check',root],{encoding:'utf8',timeout:60000});return{ok:true,value:JSON.parse(checked.stdout)}}),
]
const writeTool=tools.find(tool=>tool.action==='design.write_files')
writeTool.semanticVersion='sdk593-actual-file-readback-1'
writeTool.verify=async(context,input,value)=>{
 await authorize(context)
 const fields=Object.keys(value.shas),mismatches=[]
 for(const path of fields){scopedPath(path);const actual=hash(await readFile(join(root,path),'utf8'));if(actual!==value.shas[path])mismatches.push(path)}
 return{status:mismatches.length?'failed':'passed',evidence:{resource:'sdk-probe-artifact',fields,mismatches}}
}
const upstreamBody=await readFile(join(upstream,'SKILL.md'),'utf8')
const skill={name:'claude-design',version:'sdk593-current-source-scope',description:'Create the requested editable Design canvas artboards.',actions:tools.map(tool=>tool.action),body:'For a single-concept explanation, first deliver one complete self-contained explanatory artboard covering the mechanism and its limits. Save its index entry and actual file together, then check; a cover or a future-board list is not an explanation. SDK qualification host adaptation: this existing canvas lives in project/canvas.json. There is no shell or open/upload command. Use only registered design tools. read_reference uses the actual page filename; read format.md first. current lists real file paths/hashes. write_files saves whole file text and ifMatch uses the sha256 from reads. The user sees written artboards; never invent an URL. check invokes the actual upstream checker. Ignore upstream local CLI calls and its obsolete host addresses; their format requirements remain. Unsupported tools do not exist in this scope.\n\n'+upstreamBody}
const index=skillIndex(skill),selection={name:index.name,version:index.version,hash:index.hash}
const loaded=context=>context.executionSteps?.some(step=>step.kind==='skills__load'&&step.requestVersion===context.snapshotVersion?.requestVersion&&step.output!==undefined&&(()=>{try{const value=JSON.parse(step.input.arguments);return Object.entries(selection).every(([key,value2])=>value[key]===value2)}catch{return false}})())
class Policy extends DefaultRuntimePolicy{
 requiredTool(context){return loaded(context)?undefined:'skills__load'}
 kernelCapabilities(context){return super.kernelCapabilities(context).filter(grant=>loaded(context)||grant.name!=='design')}
 productRules(candidate,context){return super.productRules(candidate,context)+'\nSelect this exact current scoped skill before any Design operation: '+JSON.stringify(selection)+'\nCurrent real file: project/canvas.json. Reference directory: '+references.join(', ')+'\nFinish the requested actual files and design.check before final satisfaction. No process-only completion.\n'+(loaded(context)?'Complete current registered skill guidance:\n'+skill.body:'Authorized guidance-dependent schema for planning, not callable until load: '+JSON.stringify(tools.map(({name,action,parameters,description})=>({name,action,parameters,description}))))}
 validateCompletion(text,assessment,context){
  if(assessment.status==='satisfied'){
   const steps=context.executionSteps??[],write=steps.map(step=>step.kind==='design__write_files').lastIndexOf(true)
   const checked=steps.slice(write+1).reverse().find(step=>step.kind==='design__check')
   let passed=false;try{passed=JSON.parse(checked?.output??'{}').receipts?.some(receipt=>receipt.action==='design.check'&&receipt.result?.ok&&receipt.result.value?.problems===0)}catch{}
   if(write<0||!passed)return 'Write the requested actual artboards, finish every indexed file and run design.check until problems is 0.'
  }
  return super.validateCompletion(text,assessment,context)
 }
}
const db=new PGlite();await db.exec(await readFile(packageResources().schema,'utf8'))
let tail=Promise.resolve();const acquire=async()=>{let release;const previous=tail;tail=new Promise(resolve2=>{release=resolve2});await previous;return release}
const query=async(sql,params)=>{const result=await db.query(sql,params);return{rows:result.rows,rowCount:result.affectedRows??result.rows.length}}
const pool={async query(sql,params){const release=await acquire();try{return await query(sql,params)}finally{release()}},async connect(){return{query,release:await acquire()}}}
const app=await createLingxiOS({database:pool,background:{role:'passive'},performance:{notifications:false},tools,skills:[skill],realtime:{allowPublicText:()=>true},delivery:{onEvent:async()=>{},deliverMessage:async()=>({messageId:'sdk-only-probe-receipt'})}})
const identity={runId:'sdk593-'+randomUUID(),tenantId:'sdk-probe',principalId:'probe-human',agentId:'probe-agent',sessionId:'probe-room'}
const worker=createWorker({controlPlane:app,policy:new Policy(),model:{id:process.env.OPENAI_MODEL,baseUrl:process.env.OPENAI_BASE_URL,apiKey:process.env.OPENAI_API_KEY,publicTextProtocol:'purpose-json-v3',publicTextContinuation:'typed-message-v1',publicAnswerTool:'native-v3',capabilities:{parallelTools:true,jsonObjectWithTools:false},contextWindowTokens:1_000_000,maxThinkingTokens:0,requestTimeoutMs:90000,firstByteTimeoutMs:30000,streamIdleTimeoutMs:30000,auxiliaryStreaming:true},modelBudget:{maxModelCalls:24,wallClockMs:240000},worker:{id:'sdk593-probe',concurrency:1}})
const started=Date.now()
try{
 await app.enqueue({id:identity.runId,tenantId:identity.tenantId,principalId:identity.principalId,agentId:identity.agentId,sessionId:identity.sessionId,text:'为我在画板中讲解flashattention',mode:'execute',codeExecution:'disabled'})
 await worker.runNext();const state=await app.readRunState(identity)
 const failures=(await pool.query("SELECT kind,data FROM lingxios.agent_run_events WHERE run_id=$1 AND kind IN ('model.failed','run.failed') ORDER BY seq",[identity.runId])).rows
 const failureEvents=failures.map(row=>({kind:row.kind,diagnostics:publicModelDiagnostics(row.data.modelDiagnostics??{}),...(row.data.budgetLimit?{budgetLimit:row.data.budgetLimit}:{})})),protocol=failureEvents.filter(row=>row.kind==='model.failed').map(row=>row.diagnostics.protocolCode??row.diagnostics.category??'unclassified')
 const results=(await pool.query("SELECT i.intent->'action'->>'action' AS action,r.result->>'ok' AS ok,r.result->>'code' AS code FROM lingxios.agent_action_intents i JOIN lingxios.agent_action_ledger r USING(idempotency_key) ORDER BY i.recorded_at,i.idempotency_key")).rows
 const final=spawnSync(process.execPath,[join(upstream,'scripts/artifact.mjs'),'check',root],{encoding:'utf8',timeout:60000}),check=JSON.parse(final.stdout)
 const report={scope:'unpublished compatible SDK source; PGlite and scoped scratch artifact tools, NOT Loop product acceptance',binding:'native-v3',elapsedMs:Date.now()-started,status:state?.run.status,verification:state?.run.goalOutcome?.verification,gapCount:state?.run.goalOutcome?.gaps?.length??0,verifications:(await pool.query('SELECT checker,status FROM lingxios.agent_verifications WHERE work_id=$1',[identity.runId])).rows,protocolFailures:protocol,failureEvents,actions:results,checkProblems:check.problems,files:[...files].map(([path,body])=>({path,sha256:hash(body)})),accepted:state?.run.status==='succeeded'&&!protocol.length&&results.every(row=>row.ok==='true')&&check.problems===0&&results.some(row=>row.action==='design.check')&&[...files.keys()].some(path=>path.endsWith('.dc.html')),browserValidated:false}
 console.log(JSON.stringify(report))
 if(process.env.ISSUE593_SDK_EVIDENCE_PATH){const output=resolve(process.env.ISSUE593_SDK_EVIDENCE_PATH);await mkdir(output,{recursive:true});await writeFile(join(output,'real-model.json'),JSON.stringify(report,null,2)+'\n');for(const[path,body]of files)await writeFile(join(output,path.replaceAll('/','-')),body)}
 assert.equal(report.accepted,true)
}finally{await worker.stop();await app.stop();await db.close();await rm(root,{recursive:true,force:true})}
