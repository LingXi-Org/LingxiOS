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
