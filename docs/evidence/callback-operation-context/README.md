# Callback operation cancellation acceptance

Base: `a02e7aab414364f716ff91d6fd0821b42dddabdd` (published runtime 3.5.5).
Candidate: runtime 3.5.6, unchanged schema 12. Local checks used Node 22.23.3
and PostgreSQL 16.15 on Linux; no provider calls or production writes.

- `baseline-red.json`: before implementation, all six public methods ignored
  cancellation and remained in actual PostgreSQL lock waits beyond 400 ms. The
  single application connection kept an unrelated query queued. All six
  pre-aborted methods still acquired connections. The fixture subsequently gained
  the additional transaction/replay cases below; the first twelve checks stayed
  unchanged.
- `postgres-green.json`: 16/16 checks passed. Each cancelled public operation
  rejected, the waiting server backend disappeared in 99.19–104.17 ms, and the
  unrelated query completed before releasing the blocker. Pre-aborted calls
  acquired zero connections. Shared absolute deadline, session setting restore,
  rollback after message/work inserts, a 120 ms deadline during `pg_sleep` (124 ms
  observed), actual commit with lost acknowledgement plus idempotent replay,
  tenant separation and current membership revocation also passed.
- `short-tests.tap`: 9/9 public type, deadline, listener and uncertain-commit
  checks passed. `regressions.tap`: 24/24 collaboration, terminal feedback, jobs
  and outbox checks passed. `package-install.tap`: 1/1 standalone package install
  and runtime check passed. All had zero skips/failures.
- The first direct standalone-package test launch failed before packing because
  the test's fallback npm CLI path was unavailable. The failure remains in
  `package-install-launch-failure.tap`; setting `npm_execpath` to the existing
  installed npm CLI produced the passing run, without modifying source.

Reproduce: `npm run build`; run the test files named above with `node --test`.
For real PostgreSQL, create an empty disposable database and run
`LINGXIOS_OPERATION_TEST_DATABASE_URL=<url> node scripts/test-operation-context.mjs`.
The release gate now creates an independent `gate_operations` database. Local
fixture databases were dropped after each run. `source-hashes.json` identifies
candidate implementation/test inputs; `SHA256SUMS` covers this evidence.

These measurements are controlled local acceptance evidence, not production
incident causality or a benchmark of real model providers. No long soak, live
provider, real charge, full product SPA or network partition test was run. The
PostgreSQL socket-polling platform limits and explicit unsupported-settings
failure are described in `docs/operation-context-failure-model.md`. The product
must pass its callback context and formally pin the published package before
claiming its callback chain is fixed. This branch is not merged or published.

## Socket-error review follow-up

Independent review of initial commit `c4d486d1f7b093a03fe3c5014b4abaddad80ebc9`
found that pg emits an `error` event as well as rejecting a query after a checked-out
socket disconnect. The initial checks and CI for that commit did **not** cover or
qualify this correction. Their evidence remains above; initial source hashes are
preserved in `source-hashes-initial.json`.

Before this follow-up implementation, `socket-error-red.tap` reproduced process
exit 1 from an unhandled event after the local protocol server received SQL, and
missing nested listener ownership (0/2). Both the red subprocess and green run use
Node 22.23.3. `listener-ownership-red.tap` preserves the additional red check for
removing only owned subscriptions, including duplicate listeners.

`socket-error-green.tap` now passes 16/16 focused and wakeup tests with zero skips: the real pg
client/socket test now rejects normally, acquires a replacement connection within
the same max-1 pool, and serves the next request. Its diagnostic records the child
Node version and recovery result. Nested wrappers discard once and clean their
own error subscriptions without disturbing unrelated subscribers. Optional public
`SqlClient.on/off('error')` hooks preserve clients that do not expose events.

`postgres-socket-green.json` reruns all 16 real PostgreSQL cases on this candidate:
all passed, blocked backends exited in 93.48–100.61 ms and the deadline sleep ended
in 125 ms. The 24 earlier broader regressions and standalone package check are
historical results for the first commit; exact follow-up CI must qualify the final
commit before merge. `source-hashes.json` now includes the changed deadline pool,
SqlClient contract and socket test. No migration or production operation occurred.

### Exact CI type correction

Socket commit `23d39348c50bc0795b56882a1ac813a685b7a85d` failed
[exact CI 39349188098](https://github.com/LingXi-Org/LingxiOS/actions/runs/39349188098)
at build: `NotificationClient.on` needed an explicit error-event overload matching
its extended `SqlClient`. The local build had the same TS2430 error, preserved in
`socket-build-red.log`; its shell did not stop on failure and TypeScript emitted
JavaScript, so the runtime tests passed despite failed compilation. Those results
must not be read as successful typecheck/build evidence.

The one-line overload correction changes no runtime behavior. The subsequent
`set -e` command completed `npm run build` with exit 0 (`socket-build-green.log`)
and all 16 socket/context/deadline/listener/wakeup tests with exit 0. Previous
socket-candidate source hashes remain in `source-hashes-socket.json`; the latest
hashes include `wakeup.ts`. The final commit still requires its own successful CI.
