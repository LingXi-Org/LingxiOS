import assert from 'node:assert/strict'
import { it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { OpenAIChatDriver } from '../src/model/openai.js'
import { ModelDriverError } from '../src/errors.js'
import { acquireCircuit, modelFailure } from '../src/model/recovery.js'

it('preserves only allowlisted provider codes from bounded error bodies', async () => {
  const driver = new OpenAIChatDriver(`metadata-${randomUUID()}`,{ apiKey: 'PRIVATE_KEY',maxAttempts: 1,
    fetchImpl: async () => Response.json({ error: { code: 'insufficient_quota',message: 'PRIVATE_BODY' } },
      { status: 402,headers: { 'x-request-id': 'safe-request' } }) })
  await assert.rejects(driver.structured({ instructions: 'PRIVATE_PROMPT',input: {} }),error => {
    assert.ok(error instanceof ModelDriverError)
    assert.equal(error.diagnostics.providerCode,'insufficient_quota')
    assert.equal(error.diagnostics.requestId,'safe-request')
    assert.doesNotMatch(JSON.stringify(error.diagnostics),/PRIVATE_/)
    return true
  })
})

it('classifies SDK metadata without retaining error bodies, secrets or arbitrary fields', () => {
  const failure = modelFailure(Object.assign(new Error('PRIVATE_BODY'),{ status: 429,code: 'insufficient_quota',
    request_id: 'safe-request',headers: new Headers({ 'retry-after': '2' }),body: 'PRIVATE_PROMPT' }))
  assert.equal(failure.category,'quota'); assert.equal(failure.retryable,false)
  assert.equal(failure.providerCode,'insufficient_quota'); assert.equal(failure.requestId,'safe-request')
  assert.equal(failure.retryAfterMs,2000)
  assert.doesNotMatch(JSON.stringify(failure),/PRIVATE_/)
  const unknown = Object.assign(new Error('PRIVATE_BODY'),{ status: 503,code: 'PRIVATE_CODE',request_id: 'secret with spaces' })
  assert.equal(modelFailure(unknown).category,'unavailable')
  assert.equal(modelFailure(unknown).providerCode,undefined); assert.equal(modelFailure(unknown).requestId,undefined)
  const hostile = Object.create(null)
  Object.defineProperty(hostile,'status',{ get() { throw new Error('PRIVATE_GETTER') } })
  assert.equal(modelFailure(hostile).category,'unknown')
})

it('an older in-flight completion cannot release another caller half-open probe', t => {
  let now = 1000
  t.mock.method(Date,'now',() => now)
  const key = randomUUID(), older = acquireCircuit(key,100), open = acquireCircuit(key,100)
  open({ category: 'quota',retryable: false })
  now += 101
  const probe = acquireCircuit(key,100)
  older()
  assert.throws(() => acquireCircuit(key,100),/circuit is open/)
  probe()
  acquireCircuit(key,100)()
})
