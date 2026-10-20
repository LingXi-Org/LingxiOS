# Issue 216: deletion confirmation and extraction completeness

Based on OS `b8bbef2762c782c75079c3f81113296e95d17bb1`, independently
branched as `codex/issue216-confirmation-completeness`. Runtime implementation
is frozen at `47e1a847ec0d42d6e664625d6444ce3a1971cf5d`; subsequent changes
are tests/evidence. Product qualification uses PR224's
`cef2349c71f576ca53e76a1b12eacfdec5f75eba`. The package is a local source
candidate (package-proof.json), not a published release.

## Changes

The original reviewed deletion already committed, advanced the epoch, and
correctly stopped the next model call. Native recovery now recognizes a
successful deletion receipt bound to the current run, request and identity,
reauthorizes its scope, and commits a fixed, content-free acknowledgment through
the existing result/outbox transaction. It does not refresh admission, call the
model, replay the mutation, quote source text, attach earlier presentations,
or claim completion of other requested work. Outcome is explicitly partial.
Recovery after interruption uses the same receipt and a newly acquired lease.
Cancellation, revocation and request revision prevent the old acknowledgment.
The server-only confirmation option is not exposed through HostPort or HTTP.

Page processing now retains a small source-version/hash/epoch checkpoint in
existing durable source-work metadata. A successful last page cannot erase an
earlier rejection. Every active scope participates in aggregate source status.
An unproven legacy prefix is conservatively not accepted as complete.
No schema or migration numbers change (OS13 / product0047).

Real-provider testing then reproduced an additional omission: empty proposals
skipped independent review and silently lost a tail fact. All human pages now
receive independent coverage review, including empty proposals. A syntax or
coverage failure may use one shared repair allowance; the repair must pass a
new independent review. The page makes at most four model calls, all through
the existing deadline, cancellation, concurrency and cost ledger. Missing
coverage verdicts or cancellation leave the cursor pending. Exhausted review
rejects the page, while unread pages continue. No reviewer is overridden.

`MemoryDiagnostics.maintenance` adds optional `rejectedSources` and
`retryableSources` counters. Existing consumers remain compatible. Rejected
review windows are not automatically retried indefinitely. Pending jobs retain
the existing three-attempt failure recovery. Incomplete capture remains pending
but is not reported as eligible work after all captured segments are consumed.
This fix does not retroactively relabel old terminal rows from an earlier binary.

## Evidence and limits

- `deletion-red.json`: original worker path, both successful deletions had zero
  committed confirmations. `baseline-deletion-probe.mjs` is the original probe.
- `deletion-final.json`: six official-worker scenarios pass. Normal scope
  forgetting and selective deletion commit one safe result; interrupted work
  recovers without replay. Cancellation/revocation/revision commit no result.
  Model calls remain one and admission remains stale. A stopped fixture's lease
  timestamps are advanced to simulate expiry before the replacement claims it.
- `pages-red.tap`: rejected middle page incorrectly became processed.
  `coverage-red.tap`: empty extraction bypassed coverage review.
  `coverage-final.tap`: 17 focused tests pass, including bounded repair,
  missing verdict, cancellation, scope aggregation, incomplete input and
  existing synthesis/version/forget protections.
- `native-regression.tap`: initial 67-test run passed 66. The assistant-only
  test had fabricated a cursor without an accepted prefix. Its positive
  behavior remains tested, now using an actual accepted first page; it passes
  in the final 17-test run. The unchanged 66 checks were not repeated.
- `product-owning.tap`: all four owning product tests pass, including native
  memory activity/durable delivery (previously failing), room/Agent isolation,
  compaction/restart and memory latency. `product-typecheck.log` passes.
  These ran against the first deletion/state fix; the later change affects
  the auxiliary synthesis processor.
- `live-coverage-red.json`: real GLM-5.2 deletion succeeds; automatic extraction
  loses the tail while claiming processed. `live-synthesis-final.json` uses the
  same real provider and official worker, then finds both middle and tail facts
  across six segments. All ten calls have measured usage; cost is 34,100
  costMicros. Provider responses are not replaced.
- `live-foreground-no-receipt.json` retains a later real run that produced no
  deletion receipt in eleven requests. It is a failure, not a successful
  deletion/confirmation. The final synthesis-only probe isolates the changed
  auxiliary path; it does not erase or count that foreground run as passed.
  Two earlier harness configuration failures made zero provider requests
  (`live-results.json`, `invalid-probe-configuration.json`).
- Full product live-continuity results are recorded separately when the bounded
  run finishes. No new browser screenshots: this changes native backend
  behavior; PR35 retains the existing unchanged UI checks.

The initial boundary probe's `deletion-boundaries.json` is also retained: its
restart attempt ran before lease expiry. That fixture was corrected to wait
logically for expiry, without changing production lease behavior. Intermediate
working-tree green records are not release provenance.

## Reproduce

Use Node22 and existing test dependencies. Run in the OS checkout:

```sh
npm run build
node --test --test-concurrency=1 dist/test/memory-deletion-confirmation.test.js dist/test/memory-page-completeness.test.js dist/test/memory-synthesis.test.js dist/test/memory-rejected-tail.test.js
node docs/evidence/issue-216-confirmation-completeness/deletion-probe.mjs "$PWD" /tmp/deletion-counts.json
EVAL_CANDIDATE_MODEL=zai-org/GLM-5.2 EVAL_CANDIDATE_INPUT_CNY_PER_MILLION=8 EVAL_CANDIDATE_OUTPUT_CNY_PER_MILLION=28 lingxi-prod model-run node docs/evidence/issue-216-confirmation-completeness/live-probe.mjs "$PWD" /tmp/synthesis-counts.json --synthesis-only
```

Only existing authorized provider configuration is used; no new credentials or
persistent access. JSON output paths must not already exist. For source-package
qualification in the isolated product checkout, use its normal public imports:

```sh
npm run server:typecheck
MEMORY_LATENCY_LABEL=candidate node e2e/server/memory-regression.mjs native-memory.test.ts memory-continuity.test.ts memory-latency.test.ts
OPENAI_EMBEDDING_MODEL=BAAI/bge-m3 EVAL_CANDIDATE_MODEL=zai-org/GLM-5.2 EVAL_CANDIDATE_INPUT_CNY_PER_MILLION=8 EVAL_CANDIDATE_OUTPUT_CNY_PER_MILLION=28 lingxi-prod model-run node e2e/server/memory-regression.mjs --live-continuity
```

No merge, package publication, deployment, issue closure, production-data
mutation, authentication change or security-permission change was performed.
The sole integrator still owns the combined public API release and exact
published dependency pin. This PR is not evidence that all of issue216 or the
current production release is accepted.
