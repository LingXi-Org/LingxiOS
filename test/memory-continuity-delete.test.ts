import assert from 'node:assert/strict'
import { it } from 'node:test'
import { memoryFixture, content, identity, scope } from './memory-fixture.js'

it('lets the current stable-scope owner delete after historic room revocation without allowing rewrites', async () => {
  let revoked = '', currentWrite = true
  const f = await memoryFixture({ resolveScopes: async actor => actor.tenantId === 't' && actor.principalId === 'u' && actor.sessionId !== revoked
    ? [{ ...scope, continuity: 'principal', readOnly: actor.sessionId === 'new-room' && !currentWrite }] : [] })
  try {
    const a = await f.source({ sessionId: 'old-room', capture: false }), b = await f.source({ sessionId: 'new-room', capture: false })
    const old = { ...identity, sessionId: a.work.sessionId, workId: a.work.id }, now = { ...identity, sessionId: b.work.sessionId, workId: b.work.id }
    const stable = (await f.api.scopes(old))[0]!
    const doc = (await f.api.initialize(old, { scope: stable, documents: [content()], idempotencyKey: 'seed', sourceRef: 'settings' })).documents[0]!
    revoked = 'old-room'
    assert.equal((await f.api.scopes(now))[0]!.scopeId, stable.scopeId)
    assert.ok(await f.api.read(now, stable, doc.id))
    const base = { scope: stable, idempotencyKey: 'delete', sourceRef: 'current-request' }
    await assert.rejects(f.api.apply(now, { ...base, changes: [{ action: 'update', id: doc.id, expectedVersion: doc.version, content: content('replacement') }] }), /source scope was revoked/)
    await assert.rejects(f.api.apply(now, { ...base, changes: [{ action: 'delete', id: doc.id, expectedVersion: doc.version + 1 }] }), /stale/)
    currentWrite = false
    await assert.rejects(f.api.apply(now, { ...base, changes: [{ action: 'delete', id: doc.id, expectedVersion: doc.version }] }), /scope|authoriz/i)
    currentWrite = true
    const request = { ...base, changes: [{ action: 'delete' as const, id: doc.id, expectedVersion: doc.version }] }
    assert.deepEqual((await f.api.apply(now, request)).deleted, [doc.id])
    assert.equal(await f.api.read(now, stable, doc.id), null)
    assert.deepEqual((await f.api.apply(now, request)).deleted, [doc.id])
    await assert.rejects(f.api.read(old, stable, doc.id), /scope|authoriz/i)
  } finally { await f.close() }
})
