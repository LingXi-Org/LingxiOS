// Controlled provider qualification: no DB, no production writes, two local reads,
// at most three generation requests per profile; no format correction/retry loop.
import { writeFile } from 'node:fs/promises'
import { OpenAIChatDriver } from '../dist/src/model/openai.js'
import { publicAnswerHistory } from '../dist/src/protocol/public-answer-call.js'
const tools = ['tcp','udp'].map(protocol => ({ name: `demo__${protocol}`, action: `demo.${protocol}`, effect: 'read', approval: false,
  description: `Read the fixed ${protocol.toUpperCase()} demonstration observation.`, parameters: { type:'object', properties:{}, additionalProperties:false } }))
const output = process.argv[2]
if (!output) throw new Error('Pass an evidence JSON output path')
if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_BASE_URL) throw new Error('Configured provider credentials are required')
const reports = []
for (const version of ['native-v1','native-v2']) {
  const start = performance.now(), report = { version, qualification:'controlled real provider; synthetic read-only observations; no Worker or browser', model:'deepseek-ai/DeepSeek-V4.1-Flash',
    requests:0, firstPublicMs:null, toolStarts:[], rounds:[], usage:[], cost:'not measured; no provider billing receipt' }
  const model = new OpenAIChatDriver(report.model, { apiKey:process.env.OPENAI_API_KEY, baseUrl:process.env.OPENAI_BASE_URL,
    publicTextProtocol:'purpose-json-v3', publicTextContinuation:'typed-message-v1', publicAnswerTool:version,
    capabilities:{parallelTools:version==='native-v2', jsonObjectWithTools:false}, maxAttempts:1, maxOutputTokens:1800,
    maxThinkingTokens:0, requestTimeoutMs:45000, firstByteTimeoutMs:20000, streamIdleTimeoutMs:20000 })
  const items = [{role:'user', content:'先说明 TCP 与 UDP 的核心差异，再读取 demo__tcp 和 demo__udp 的固定演示观察，根据观察给出简短对比。工具互不依赖。只用已有事实，不要另外复核；如果本轮契约允许，把公开解释与两个读取放在同一轮。'}]
  try {
    for (let round=0; round<(version==='native-v1'?1:3);round++) {
      const began=performance.now();report.requests++
      const turn=await model.run({instructions:'Use the public output protocol exactly. All business tools are local synthetic read-only demonstrations. Explain reliable ordered byte streams versus independent datagrams accurately. Observations never prove a real network benchmark. After both observations, conclude and stop.',
        items, tools, codeExecution:'disabled', answerContext:{messageId:'controlled',segmentIds:round?['controlled-source']:[]}, signal:AbortSignal.timeout(45000),
        onTextOperation:()=>{}, onTextDelta:(text,metadata)=>{if(text.trim()&&metadata?.purpose==='answer'&&report.firstPublicMs===null)report.firstPublicMs=performance.now()-start} })
      const calls=turn.output.filter(item=>item.type==='function_call')
      report.rounds.push({durationMs:performance.now()-began,publicText:turn.text,callNames:calls.map(call=>call.name),outcome:turn.outcomeDeclaration??null})
      report.usage.push(turn.usage)
      if(turn.publicAnswerCall)items.push(...publicAnswerHistory(turn.publicAnswerCall,{version:1,sources:[]}))
      items.push(...turn.output)
      if(turn.outcomeDeclaration){report.status='completed';break}
      const unknown=calls.some(call=>!tools.some(tool=>tool.name===call.name)||call.arguments.trim()!=='{}')
      if(unknown)throw new Error('unexpected_demo_call')
      for(const call of calls)report.toolStarts.push({name:call.name,atMs:performance.now()-start})
      items.push(...await Promise.all(calls.map(async call=>({type:'function_call_output',callId:call.callId,output:JSON.stringify({status:'completed',value:call.name==='demo__tcp'?{protocol:'TCP',fixedObservation:'A lost segment is retransmitted; application receives bytes in order.'}:{protocol:'UDP',fixedObservation:'One datagram is absent; later datagrams can still be received independently.'}})}))))
      report.status='bounded_without_terminal'
    }
  } catch(error) {report.status='failed';report.failure={name:error?.name??'Error',kind:error?.diagnostics?.kind??'unknown',category:error?.diagnostics?.category??'unknown',protocolCode:error?.diagnostics?.protocolCode??null,status:error?.diagnostics?.status??null}}
  report.totalMs=performance.now()-start;reports.push(report)
  await writeFile(output,JSON.stringify(reports,null,2)+'\n')
  console.log(JSON.stringify({version,status:report.status,requests:report.requests,firstPublicMs:report.firstPublicMs,toolCalls:report.toolStarts.length,totalMs:report.totalMs,failure:report.failure}))
}
