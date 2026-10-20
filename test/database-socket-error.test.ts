import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { it } from 'node:test'
import { deadlinePool } from '../src/control-plane/deadline-pool.js'
import type { SqlPool } from '../src/index.js'

it('contains a real pg client socket failure and serves the next request with a replacement connection', t => {
  // Isolate the driver error event so a regression is an assertion, not a crash
  // of the test runner. No database, credentials or external server is involved.
  const script = `
    import assert from 'node:assert/strict'
    import { createServer } from 'node:net'
    import { createRequire } from 'node:module'
    import { deadlinePool } from ${JSON.stringify(new URL('../src/control-plane/deadline-pool.js', import.meta.url).href)}
    import { withRuntimeOperation } from ${JSON.stringify(new URL('../src/app/operation-context.js', import.meta.url).href)}
    const { Pool } = createRequire(${JSON.stringify(import.meta.url)})('pg')
    const frame = (type, body) => { const size = Buffer.alloc(4); size.writeInt32BE(body.length + 4); return Buffer.concat([Buffer.from(type), size, body]) }
    const ready = frame('Z', Buffer.from('I'))
    let connections = 0, observedQueryDisconnect = false
    const server = createServer(socket => {
      const connection = ++connections
      let started = false, buffer = Buffer.alloc(0)
      socket.on('error', () => {})
      socket.on('data', bytes => {
        buffer = Buffer.concat([buffer, bytes])
        if (!started) {
          if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return
          buffer = buffer.subarray(buffer.readInt32BE(0)); started = true
          socket.write(Buffer.concat([frame('R', Buffer.alloc(4)), ready]))
        }
        while (buffer.length >= 5 && buffer.length >= buffer.readInt32BE(1) + 1) {
          const type = String.fromCharCode(buffer[0]), length = buffer.readInt32BE(1) + 1
          buffer = buffer.subarray(length)
          if (type === 'X') { socket.end(); return }
          if (type !== 'Q') throw new Error('expected a simple synthetic query')
          if (connection === 1) {
            observedQueryDisconnect = true
            console.log(JSON.stringify({ observedQueryDisconnect }))
            socket.destroy(); return
          }
          const fields = Buffer.alloc(18); fields.writeInt32BE(23, 6); fields.writeInt16BE(4, 10); fields.writeInt32BE(-1, 12)
          const row = Buffer.alloc(7); row.writeInt16BE(1); row.writeInt32BE(1, 2); row[6] = 49
          socket.write(Buffer.concat([frame('T', Buffer.concat([Buffer.from([0,1]), Buffer.from('value\\0'), fields])),
            frame('D', row), frame('C', Buffer.from('SELECT 1\\0')), ready]))
        }
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const pool = new Pool({ host: '127.0.0.1', port: server.address().port, user: 'fixture', database: 'fixture',
      ssl: false, max: 1, connectionTimeoutMillis: 500 })
    try {
      const wrapped = deadlinePool(pool)
      await assert.rejects(withRuntimeOperation(wrapped, { deadlineAt: new Date(Date.now()+1000).toISOString() }, db => db.query('SELECT 1')),
        /Connection terminated unexpectedly/)
      const recovered = await wrapped.query('SELECT 1 AS value')
      assert.equal(recovered.rows[0].value, 1)
      assert.equal(connections, 2); assert.equal(pool.totalCount, 1); assert.equal(pool.idleCount, 1)
      console.log(JSON.stringify({ nodeVersion: process.version, callerRejected: true, nextRequestRecovered: true, connections, poolMax: 1 }))
    } finally { await pool.end(); await new Promise(resolve => server.close(resolve)) }
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 })
  assert.ifError(child.error)
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`)
  assert.match(child.stdout, /"observedQueryDisconnect":true/)
  assert.match(child.stdout, /"nextRequestRecovered":true/)
  t.diagnostic(child.stdout.trim())
})

it('owns and cleans nested client error listeners on failure and successful release', async () => {
  const emitter = new EventEmitter(), releases: Array<Error | undefined> = []
  const unrelated = () => {}
  emitter.on('error', unrelated)
  const raw = { async query() { return new Promise<never>(() => {}) }, release(error?: Error) { releases.push(error) },
    on: emitter.on.bind(emitter), off: emitter.off.bind(emitter) }
  const pool: SqlPool = { query: raw.query, connect: async () => raw }
  const wrapped = deadlinePool(deadlinePool(pool))
  const client = await wrapped.connect()
  assert.equal(emitter.listenerCount('error'), 3)
  const pending = client.query('SELECT pending')
  emitter.emit('error', new Error('synthetic connection lost'))
  await assert.rejects(pending, /synthetic connection lost/)
  await assert.rejects(client.query('SELECT later'), /synthetic connection lost/)
  client.release()
  assert.equal(releases.length, 1)
  assert.equal(releases[0]?.message, 'synthetic connection lost')
  assert.deepEqual(emitter.listeners('error'), [unrelated])
  const next = await wrapped.connect()
  assert.equal(emitter.listenerCount('error'), 3)
  next.off!('error', unrelated)
  assert.ok(emitter.listeners('error').includes(unrelated), 'a wrapper only removes subscriptions it owns')
  const duplicate = () => {}
  next.on!('error', duplicate); next.on!('error', duplicate)
  assert.equal(emitter.listeners('error').filter(listener => listener === duplicate).length, 2)
  next.off!('error', duplicate)
  assert.equal(emitter.listeners('error').filter(listener => listener === duplicate).length, 1)
  next.release()
  assert.deepEqual(emitter.listeners('error'), [unrelated])
  assert.equal(releases.length, 2)
  assert.equal(releases[1], undefined)
})
