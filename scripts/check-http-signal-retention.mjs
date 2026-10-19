// End-to-end synthetic HTTP, without production credentials or external services.
// Failure modes: healthy requests retain parent signal registrations; deferred timers
// mimic a leak; event loop turns/GC finalizers incomplete; transport resource leakage.
import assert from 'node:assert/strict'
import { HttpHostClient } from '../dist/src/host/http-client.js'
import http from 'node:http'
import {setImmediate as immediate,setTimeout as delay} from 'node:timers/promises'
if (!global.gc) throw new Error('run with --expose-gc after building')
const server=http.createServer(async(req,res)=>{for await(const chunk of req){};res.writeHead(200,{'content-type':'application/json'});res.end(req.url.endsWith('/claim')?'null':'\"synthetic-cursor\"')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port
const root=new AbortController()
const client=new HttpHostClient({baseUrl:`http://127.0.0.1:${port}`,serviceToken:'synthetic-only',workerId:'synthetic-worker',requestTimeoutMs:5000})
const samples=[]
try {
 for(let batch=0;batch<5;batch++){
  for(let i=0;i<5000;i++){await client.claimWork(root.signal);await client.waitForWork('synthetic-cursor',1,root.signal)}
  await delay(5500);for(let i=0;i<4;i++){global.gc();await immediate()}
  samples.push({requests:(batch+1)*10000,heap:process.memoryUsage().heapUsed});console.log(JSON.stringify(samples.at(-1)))
 }
}finally{root.abort();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()})}
console.log(JSON.stringify({node:process.version,samples,growth:samples.at(-1).heap-samples[0].heap}))
assert.ok(samples.at(-1).heap - samples[0].heap < 4 * 1024 * 1024, 'completed HTTP polls retain memory on their long-lived parent signal')
