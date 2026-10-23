# Atomic forgetting and native synthesis lock order

## Failure model

A deterministic disposable PostgreSQL test creates committed synthetic source
evidence, schedules reflection through the native API, claims that real job,
reserves a valid action intent and calls `toolExecutor(memory_synthesis.load)`.
The concurrent authorized forget API holds the scope before cancelling the
background work. The original native wrapper holds that background work before
entering synthesis and taking the scope. Barriers after actual locks and
`pg_blocking_pids` establish a real scope/work cycle; the underlying query fails
with `40P01`. This does not identify the peer of an earlier incident lacking a
deadlock DETAIL record.

## Strategy comparison

Prelocking cancellation targets in `forgetMemoryScope` alone is too late:
foreground native tools and API apply/delete paths already hold the scope.
Changing every caller would also need to prove a newly scheduled background job
cannot enter between target discovery and the scope lock. Removing or deferring
cancellation would change the atomic forgetting contract.

Instead, the native action transaction prelocks the existing persisted scope
for `memory_synthesis` work before locking its work and action intent. It first
uses the same complete live-work/intent predicate as the final lock. Its scope
and epoch come from the persisted row, and must match the leased work; tool
arguments cannot choose them. The final work/intent lock rechecks every existing
identity, live fence, cancellation and request-version condition and verifies
the discovered scope/epoch again. A mismatch fails instead of acquiring a new
scope under a work lock. Lease validity uses `clock_timestamp()` so a scope wait cannot reuse the
transaction-start clock after expiry. A real-time regression holds the scope
past the persisted lease deadline without changing the row; the old `NOW()`
predicate incorrectly allowed the action. Other work kinds retain work-first ordering; their
persisted kind must also match the leased work to prevent bypassing the rule.

This is a scoped resource hierarchy, not a tenant-wide mutex:
foreground work → memory scope → background synthesis work. Forgetting still
advances the epoch, erases evidence and cancels actual synthesis work in one
transaction. No provider or embedding I/O occurs inside these transactions.
Existing bounded serialization handling is unchanged; tests separately reject
any underlying `40P01` even when a wrapper might retry it. A serialization
conflict after a committed forget may safely reject the now-cancelled action.

Source rows later examined by synthesis are restricted to committed
`succeeded`/`partial` work, never a leased foreground admission. Native human
continuation only resumes `waiting` work. Tests and review must preserve these
state constraints; no manual reset of a completed source into leased work is
used to claim a reachable peer. This patch does not claim all unrelated native
or application lock graphs are globally ordered.
