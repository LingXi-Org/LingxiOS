import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createLingxiOS, type DeliveryContext, type RuntimeOperationContext, type SqlQueryable,
  type RunIdentity, type ConversationPolicy, type IMMessageInput } from '../src/index.js'

// Compile the public contract without executing or reaching into internal APIs.
function publicContract(app: Awaited<ReturnType<typeof createLingxiOS>>, identity: RunIdentity,
  conversation: ConversationPolicy, message: IMMessageInput, delivery: DeliveryContext, transaction: SqlQueryable) {
  const operation: RuntimeOperationContext = delivery
  return [app.readRun(identity, transaction), app.readRunState(identity, operation),
    app.readEvents(identity, 0, operation), app.readTerminal(identity, operation),
    app.readApproval({ tenantId: identity.tenantId, principalId: identity.principalId, approvalId: 'approval' }, operation),
    app.conversations.sync(conversation, operation), app.conversations.ingest(message, {}, operation)]
}
it('exports an operation context compatible with delivery callbacks and the existing transaction read', () => {
  assert.equal(typeof publicContract, 'function')
})
