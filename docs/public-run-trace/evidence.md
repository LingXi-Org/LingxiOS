# Native trace candidate evidence

Scope: LingXi-Org/LingxiOS#40 / LingXi-Org/LingxiLoop#283. Base
`6e715df85de9e6fa4d852d9102772e5c3ca4e8a7` (3.7 purpose). This branch does not
publish a package or change deployment/schema provenance. Release owner assigned
3.8.0/runTrace1 after the implementation checkpoint; never replace 3.7.0.

## Implementation

- `src/protocol/run-trace.ts`: closed public DTO and trusted timing enrichment.
- `src/control-plane/service.ts`: fenced durable start before worker continuation;
  model settlement timestamp from the control-plane clock and first-settlement
  ledger semantics. No worker-supplied timestamps can overwrite this metadata.
- `src/app/run-trace.ts`: explicit field projection, current authorization,
  native child lineage, bounded discovery, stable IDs/seq/revisions, null legacy
  fields and unknown unresolved effects. No prompt/raw result selection.
- `src/app/realtime.ts`: opt-in `{ trace: true }` replacement snapshots, including
  before-subscription spans, using the same reader and current permissions.
- `src/model/execution.ts` and `src/runtime/runtime.ts`: freeze the originating
  request version when each invocation begins, separate from later steering.

No DDL, migrations, credentials, production queries, provider accounts or UI
vendor code were used. Existing event/observation JSON gains additive metadata.
New SSE shape requires explicit opt-in; existing stream consumers receive their
existing shape by default. Public text framing and accepted-answer behavior stay
under their existing purpose tests. Formal old-package deployment compatibility
and product exact-version guard/provenance remain release integration work, not
proven by absence of DDL alone.

## Reproducible checks

```
npm run build
node --test dist/test/public-run-trace.test.js \
  dist/test/public-purpose-worker.test.js \
  dist/test/model-execution.test.js \
  dist/test/realtime-guards.test.js
```

The first pre-implementation trace run failed both cases at the missing public
`readRunTrace` method. The public trace tests now pass 5/5 against PGlite with
real control-plane leases/events/model budget persistence and public native graph
admission. They cover pre-invocation visibility, stable replay, measured/unknown
usage, absent-price cost null, wrong tenant/principal/session/thread, tool receipt
uncertainty, stale lease rejection, authorized graph children, frozen-audience
rejection, current IM revocation for reads/live SSE, local cancellation settlement
after lease completion, immutable usage, 32-run truncation and legacy/waiting nulls.

The combined targeted invocation passed 15/16 cases; its one failure was the new
bounded-history fixture trying to enqueue 40 simultaneous children, correctly
rejected by the existing eight-active-child admission policy. The fixture was
changed to five native graph batches with synthetic terminal rows between batches.
The affected trace file was then rerun: 5/5 passed. The other 11 targeted cases
passed in the combined run. No claim is made that all 16 were rerun after this
fixture-only correction.

The real Worker/local streaming provider test verifies early substantive answer
persistence before EOF/tool execution, exact final purpose acceptance, observed
agent/LLM/tool intervals and originating tool attempt, safe SSE snapshot/replay,
and no hidden-reasoning sentinel. The existing model execution/preview lease
regressions also passed. Synthetic timing is not production latency evidence.

`npm run build` (including TypeScript) and `git diff --check` passed after the
last fixture correction. No paid/provider, real-user, browser or production
acceptance is claimed. Product bridge, official package pin, release provenance,
and production health remain the sole integrator's subsequent stages.

## Independent review corrections

Independent review of `62966b7` reproduced three P2 failures with real PGlite/control-plane probes: a gated optional trace blocked subsequent committed body events; cached same-key tool replay extended its end; claim/revise changed fence/requestVersion without changing the snapshot revision. The fixed reader freezes first receipts, hashes the full root header, rechecks root and each admitted child after data collection, and rejects backwards clock intervals. SSE now uses one independent 500 ms cancellable database read and emits an explicit null snapshot on unavailability.

The affected real-persistence/SSE file passes **7/7** on Node22.23.3 (`node --test dist/test/public-run-trace.test.js`). The first combined run was **17/18**: the new timing fixture had notifications disabled and therefore exercised the existing750 ms polling interval; it was corrected to enable the actual event wakeup before asserting delivery before the500 ms diagnostic deadline. This is not a production polling change. Prior11 unchanged Worker/model/realtime cases passed in that combined run; no full-suite claim. The fixture confirms answer output while the trace query is still held, checked-out connection disposal at deadline, explicit unavailable replacement, actual SQL failure isolation and later recovery. Build and current diff whitespace check pass. The earlier candidate contained an extra trailing blank line in the new protocol file; that cosmetic check result is superseded by this corrected diff.
