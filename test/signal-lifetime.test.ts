import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { it } from 'node:test'
import { scopedSignal } from '../src/deadline.js'
import { deadlinePool } from '../src/control-plane/deadline-pool.js'
import { HttpHostClient } from '../src/host/http-client.js'

// Failure cases: parent cancellation lost, reason changed, already-aborted input,
// duplicate parents, listener/timer retained after success/error, late pool acquire,
// child cancellation after successful dispose, and cancellation during HTTP retry.
it('scopes cancellation and deadlines without retaining completed operations on their parents', async () => {
  const parent = new AbortController(), other = new AbortController()
  const scope = scopedSignal([parent.signal, parent.signal, other.signal], 10_000)
  assert.equal(getEventListeners(parent.signal, 'abort').length, 1)
  const reason = new Error('cancelled')
  other.abort(reason)
  assert.equal(scope.signal.reason, reason)
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
  scope.dispose(); scope.dispose()
  const finished = scopedSignal([parent.signal], 5)
  finished.dispose()
  await delay(10)
  parent.abort()
  assert.equal(finished.signal.aborted, false)
  assert.equal(scopedSignal([other.signal]).signal.reason, reason)
  const timeout = scopedSignal([], 1)
  await delay(5)
  assert.equal(timeout.signal.reason.name, 'TimeoutError')
})

it('releases pool parent subscriptions on success, acquisition failure and cancellation', async () => {
  const root = new AbortController()
  const raw = { async query() { return { rows: [], rowCount: 0 } }, release() {} }
  const pool = deadlinePool({ ...raw, async connect() { return raw } }, root.signal)
  for (let i = 0; i < 50; i++) await pool.query('SELECT 1')
  assert.equal(getEventListeners(root.signal, 'abort').length, 0)
  const failing = deadlinePool({ ...raw, async connect() { throw new Error('connection refused') } }, root.signal)
  await assert.rejects(failing.connect(), /connection refused/)
  assert.equal(getEventListeners(root.signal, 'abort').length, 0)
})

it('releases HTTP request parent subscriptions on success, error, synchronous throw and cancellation', async () => {
  const parent = new AbortController()
  let response: 'ok' | 'error' | 'pending' = 'ok'
  let observed: AbortSignal | null | undefined
  const client = new HttpHostClient({ baseUrl: 'http://synthetic.invalid', serviceToken: 'synthetic', workerId: 'synthetic', maxAttempts: 1,
    fetchImpl: ((_input: unknown, init?: RequestInit) => {
      observed = init?.signal
      if (response === 'error') throw new Error('synthetic transport failure')
      if (response === 'pending') return new Promise<Response>(() => {})
      return Promise.resolve(new Response('null'))
    }) as typeof fetch })
  for (let i = 0; i < 50; i++) assert.equal(await client.claimWork(parent.signal), null)
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
  response = 'error'
  await assert.rejects(client.claimWork(parent.signal), /synthetic transport failure/)
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
  response = 'pending'
  const pending = client.claimWork(parent.signal)
  const reason = new Error('stop polling')
  parent.abort(reason)
  await assert.rejects(pending, /stop polling/)
  assert.equal(observed?.aborted, true)
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0)
})
