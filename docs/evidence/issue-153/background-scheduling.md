# Background ownership and scheduling

`createLingxiOS` continues to expose the same API/control-plane/worker connection methods. Background ownership is now explicit:

```ts
// API/control owner; omitting background keeps this active behavior.
const control = await createLingxiOS({
  database,
  background: {
    role: 'active',
    databaseConcurrency: 2,
    minPollMs: 1_000,
    maxPollMs: 30_000,
    sweepIntervalMs: 60_000,
  },
})

// A worker's context-side client, when another active control owns delivery/maintenance.
const context = await createLingxiOS({ database, background: { role: 'passive' } })
```

Passive creates no background scans, maintenance timers, outbox lanes, or PostgreSQL LISTEN connection. Startup still validates storage. Explicit requests, reads, maintenance, worker connections, and realtime APIs remain available. Cross-process realtime/work wakeups use their existing bounded polling fallback in this role. At least one active control with the relevant delivery/model-call callbacks must own each deployment's durable background work; passive is not a delivery owner.

Active controls scan each named queue after the minimum interval. Empty/error scans double their delay up to `maxPollMs`; observed work resets the delay. The default empty schedule starts at roughly 1, 3, 7, 15, 31, 61 seconds, rather than every second. Database notifications and local commit/event hooks wake the relevant jobs immediately. Notifications received while a scan is running coalesce into one follow-up. Periodic scans remain authoritative when notifications are lost, unavailable, or disabled. Storage, workspace cleanup, and metrics use the separate low-frequency sweep interval.

Outboxes retain their independent durable lanes, per-stream ordering, existing result/fence/version checks, and claim-token acknowledgements. A slow transport does not prevent free lanes from scanning. Overlapping scans are bounded by configured outbox concurrency. Scan observations (`claimed`, `errors`, `active`) inform scheduling; they do not replace durable delivery state or change retry limits. A claim/acknowledgement failure retains the SQL intent for later recovery.

All background queues, outbox claims and acknowledgements, and automatic maintenance share a FIFO budget of `databaseConcurrency` simultaneous database connections. A transaction retains its permit until client release. External transport waits hold no database permit. Request/API/worker RPC queries use their existing pool directly. The dedicated active LISTEN connection is an additional pool slot and is excluded from this budget; deployments must reserve capacity for it and foreground traffic. The budget is per app instance, so products must also budget across app replicas.

`stop()` is idempotent, cancels timers and queued acquisitions, aborts active database/delivery work, drains the tracked outbox lanes, and closes the listener/control HTTP server. Delivery and extension callbacks must honor their supplied abort signal. An external callback that ignores cancellation cannot be forcibly stopped by JavaScript; any late acknowledgement remains subject to existing durable lease/claim checks.

Supported limits are: background database concurrency 1–32, minimum scan interval 1–60,000 ms, maximum scan interval from the minimum through 300,000 ms, and sweep interval 1–3,600,000 ms. Invalid settings fail before storage acquisition. `performance.notifications: false` continues to disable LISTEN while preserving periodic scans. `performance.outboxConcurrency` retains its existing 1–32 lane limit.

## Internal integration hook

New package-owned background work can register inside the active-role block using `scheduler.add('fixed name', async signal => observedWork, { concurrency?, intervalMs? })` and wake with `background('fixed name')`. Return `true` when more timely work was observed; return false/void for an empty scan; throw on failure. Use `backgroundDatabase` for all SQL, including transactions and callbacks, so the new work shares the connection budget. Do not register dynamically named per-run jobs. Registration automatically participates in scheduler shutdown. This internal helper is not a new public package export.

## Validation scope

The failure matrix was written before implementation, followed by scheduling tests; the baseline red typecheck reports the missing scheduler module and missing public background option. Deterministic tests cover empty/error/busy behavior, coalesced wakeups during scans, bounded overlap, pooled transaction release, queued/late acquisition cancellation, query exceptions, notifications, polling fallback, passive API use and idempotent shutdown. Existing durable outbox lane/order/exhaustion coverage is retained.

No product configuration, release metadata, schema, deployment, 24-hour soak, provider call, or heap-leak claim is included in this upstream scheduling change.

Validation results (2026-10-17, Node's isolated test runner, installed lockfile dependencies shared read-only from the integration checkout):

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `node --test --test-concurrency=1 dist/test/background-scheduler.test.js dist/test/outbox.test.js`: 13 passed, 0 failed.
- `node --test --test-concurrency=1 dist/test/app.test.js dist/test/reliability.test.js dist/test/deadlines.test.js dist/test/realtime.test.js dist/test/performance-migration.test.js`: 15 passed, 1 failed.
- The app/Python failure was independently reproduced on pristine `de79dd355a08e2b18a4a32ccd099eef29e9b7678` in `/tmp/LingxiOS-scheduler-baseline`: IPython creates `tmp*/profile_default/history.sqlite` inside the scanned home, so native artifact checks return `partial` instead of the test's expected `satisfied`. This test remains blocked by the baseline/environment artifact issue. No kernel/runtime code was changed for it.

Captured red typecheck, passing scheduling tests/typecheck, regression results and baseline reproduction are included beside this document as `.txt` files. These results do not replace a PostgreSQL production load or soak test.
- Additional worker/wakeup/lease recovery regressions: `node --test --test-concurrency=1 dist/test/worker.test.js dist/test/wakeup.test.js dist/test/lease-recovery-limit.test.js`: 12 passed, 0 failed (captured in `background-worker-regressions.txt`).
