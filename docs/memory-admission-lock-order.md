# Independent memory review lock order

## Failure model and scope

Final model admission and context admission lock their current work row before
checking memory scope epochs. Native transactional tools also acquire their
work and intent locks in `toolExecutor` before entering memory functions.
Independent memory review previously locked the scope first, then the same
live work row. Valid overlapping calls can therefore form a work/scope cycle.

The fix moves the independent review's existing live-work lock ahead of its
scope lock. It preserves its lease/fence, tenant/agent/principal, request
revision, cancellation, forgotten-source, document version and review-hash
checks. Scope authorization is checked again after lock waits. Admission and
native tool transactions keep their existing order; no unlocked discovery or
new retry policy is introduced. The review model request occurs after the
prepare transaction commits, so database locks never span provider I/O.

This is a bounded fix for an independently reproduced review/admission cycle.
It is not proof of the peer in an older deadlock without PostgreSQL DETAIL, nor
a claim that every memory maintenance lock is globally ordered. In particular,
`forgetMemoryScope` updates background synthesis work while holding a scope;
that separate path requires its own actual-entry-point reachability evidence.
A synthesis function's local order is insufficient evidence because its native
tool wrapper already owns the work lock before calling it.

## Deterministic PostgreSQL regression

`scripts/memory-admission-lock-regression.mjs` is part of the existing disposable
PostgreSQL store gate. It uses real `PgWorkStore` leases and request snapshots,
`createMemoryRuntime.prepareReview/context`, `PgModelBudgetStore.reserve`, and
`toolExecutor.execute(memory.reflect)` with a reserved native action intent.
No provider is called and all identities/content are synthetic.

Barriers pause transactions only after their actual entry point acquires a
scope lock; they never acquire artificial work/scope locks themselves.
`pg_blocking_pids` proves the second backend is waiting for the first before
releasing the barrier. On the original implementation, model and context
admission against independent review both report PostgreSQL `40P01`. The
regression records underlying query errors, so existing transaction retries
cannot turn a deadlock into an apparent pass.

The final cases cover:

- Both model and context admission overlapping independent review, with no
  extra model-budget reservation.
- Revocation while blocked: both admission and review reject current scope
  denial after the wait.
- A native transactional `memory.reflect` peer, proving the fix does not move
  the inversion into the work/intent wrapper. A discarded scope-first
  admission alternative failed this exact test with `40P01`.
- Stale fence, changed request/review hash, forgotten source and cancellation
  still reject at the real review entry point.

The existing memory admission and governance suites additionally retain
provider-boundary forgetting, request-revision changes, root/provider/user
cancellation, action idempotency, explicit review and protected memory tests.
The PostgreSQL gate creates only an empty disposable database; it is not a
production migration or recovery command.
