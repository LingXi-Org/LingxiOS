# Public callback operation cancellation

The product's delivery callback has one absolute deadline. Runtime reads and
conversation writes must honor it instead of starting a fresh 30 second SQL
budget for each method. The operation context contains no authorization grants.

Failure cases, recorded before implementation:

- An already aborted or expired operation acquires a connection or sends SQL.
- Authorization succeeds but later data SQL ignores the same deadline.
- Repeated methods restart the deadline, retaining a callback past its budget.
- A rejected promise releases the Node pool slot while PostgreSQL keeps the
  blocked query/backend alive. Check `pg_stat_activity`, not only pool counters.
- SQL cancellation consumes an extra pool connection and deadlocks a saturated
  pool. Keep the existing connection ceiling; no cancellation pool.
- A sync/ingest abort commits partial state, returns false success, or makes a
  replay create duplicate work. A lost COMMIT acknowledgement is uncertain;
  reject and let stable message identity reconcile the durable result.
- Scoped PostgreSQL timeout settings leak into a later ordinary operation.
- Changed membership/tenant identity bypasses authorization on replay.
- Completed calls retain signal listeners or change calls without a context.
- A checked-out PostgreSQL client emits a socket `error` in addition to rejecting
  its query. Missing event ownership crashes the process despite caller catch;
  nested wrappers must propagate failure and remove only their own listeners.

The real PostgreSQL check uses one disposable database and a one-connection
application pool. A separate test-only observer holds a table lock, observes the
actual waiting backend, and proves an unrelated `SELECT 1` can proceed before
the lock is released. No provider or production operations are involved.

## Public API

Pass the callback's existing `DeliveryContext` directly as the optional last
argument to `readRunState`, `readTerminal`, `readApproval`, `conversations.sync`,
`readEvents(identity, afterSeq, context)`, or
`conversations.ingest(message, policy, context)`. The exported
`RuntimeOperationContext` accepts `signal` and an absolute ISO `deadlineAt`.
The original `readRun(identity, transaction)` contract remains available.

One call owns at most one connection from the configured pool. Each SQL command
uses the smaller of the original nonzero `statement_timeout` and the remaining
operation budget; a call has at most 30 seconds even when its requested deadline
is farther away. The same absolute callback deadline can span multiple calls.
Successful calls restore the original session settings. Failures discard the
connection, including uncertain COMMIT outcomes; stable ingress identities
remain responsible for reconciliation. Calls without a context retain their
existing behavior.

This path requires PostgreSQL 14+ with `client_connection_check_interval` and
`statement_timeout`. Missing settings are an explicit error, not a successful
cancellation claim. The scoped interval is at most 100 ms. Socket polling is
supported on Linux, macOS, illumos and BSD; it notices a closed client after the
server kernel detects the close. It does **not** promise immediate cancellation
during every network partition. The server statement timeout remains the bound.
No server configuration, role permissions, keepalive settings or connection
limits change. PGlite unit checks do not prove socket cancellation.
See the [PostgreSQL connection-check documentation](https://www.postgresql.org/docs/16/runtime-config-connection.html#GUC-CLIENT-CONNECTION-CHECK-INTERVAL).

Run `npm run build`, then
`LINGXIOS_OPERATION_TEST_DATABASE_URL=<empty-disposable-db> node scripts/test-operation-context.mjs`.
The regular release gate creates its own database for this check.
