# Issue216 independent final candidate review — not ready

This review executes the full build of native **b8bbef2762c782c75079c3f81113296e95d17bb1**, version **3.5.8 candidate**, with Loop PR224 **cef2349c71f576ca53e76a1b12eacfdec5f75eba** through an npm-packed public source package. The portable handoff is **4c13bf6adfc9e7b8891d45f2d1afb3665d3f860f**. No runtime/product source, migration, package version, lockfile or credential was changed. No merge, package publication, deployment or issue closure occurred.

**The original reviewed negatives pass on b8, but two product acceptance failures remain. Do not close issue216 or use this report as release approval.** Both phases remain one delivery.

## Blocking findings

### P2 — a committed in-turn deletion loses its durable confirmation

The unchanged product `native-memory.test.ts:131` fails. Thirteen turn runs leave twelve delivered results and one failed run: the explicit `memory.forget` action. The mutation commits; the next context load at `src/runtime/runtime.ts:509` reaches the correct old-epoch rejection at `src/memory/admission.ts:41`, so no final result/outbox is created. All twelve existing outbox records are delivered; this is not an IM transport acknowledgement failure.

The separate [native probe](self-deletion-probe.mjs), using the official `createWorker` review wrapper, independently reproduces **both full-scope forget and selective apply/delete**. Each has a successful committed receipt, advanced epoch, selected document absent, one model call, stale admission proof, failed run and zero final results. Selective delete retains the unrelated document. [Counts](self-deletion-current.json), [failure model](SELF-DELETION-FAILURE.md).

A native correction must safely confirm the committed effect and handle the commit/response recovery gap. It must keep current audience, request version, cancellation, idempotency and the epoch fence, and must not claim unrelated remaining work is complete. Advancing/ignoring old admission proof or merely weakening the delivery assertion is not an acceptable fix. No speculative confirmation protocol was introduced into the integrator's branch.

### P2 — an intermediate rejected window is hidden by final processed status; actual middle fact remains missing

The unchanged real-provider `memory-continuity-live.test.ts:114` fails at **background captures the middle fact**. The long source is complete, and its personal scope cursor reaches **7/7**, but there is no saved middle fact. The corrected tail is saved.

[Per-page counts](live-page-counts.json) establish the narrower cause: window **1→3** contains the middle fact, the actual proposal contains it, and the independent verifier rejects that proposal (`approved:false`, confidence0.85). Later windows continue as required; final window **5→7** commits the corrected tail. `src/memory/synthesis.ts:169–180` bases the final scope status on the last window, leaving **processed** despite the earlier rejection. This is not prefix truncation, a missing segment or an embedding failure. Do not force the rejected proposal through or weaken the independent reviewer. The pipeline needs bounded rejection handling and durable completeness diagnostics; the required actual-provider middle-fact acceptance remains failed.

[Live counts](live-failure-counts.json) retain 33 measured ledger calls, including8 embedding calls, and370137 cost micros. Four current vectors are1024-dimensional in one space. Immediate cross-room input/answer, explicit middle/tail save, nonlexical semantic answer and proactive hybrid recall passed before this failure. Background new-room answer, effective-revision answer and post-forget index checks were **not reached**. No repeated live run was used to select a green sample.

## Executed evidence, separated by boundary

| Boundary | Exact b8 result | Evidence |
| --- | --- | --- |
| Build and public-source Loop server types | Passed | Hashes in VALIDATION.json |
| Diagnostic privacy, forgotten snapshots/history/restart, revoked-source owner deletion, rejected-window continuation, rollback and final admission |53/53|[original-negatives.tap](original-negatives.tap)|
| Budget partitions, optional-memory/public compatibility, child quota, execution/fallback and raw-trace controls |22/22|[public-controls.tap](public-controls.tap)|
| Long input/capture, scope continuity/migration/governance, store/synthesis, semantic indexing and evolution registration |50/50|[two-phase-native.tap](two-phase-native.tap)|
| Independent legacy full-source red/green |e8 counts0/1/1 → b8 counts0/0/0|[red](portable-red/legacy-core-counts.json), [b8](portable-current/legacy-core-counts.json)|
| Legacy compatibility (authorized original input/public answer/clean summary) |3/3; legacy counts0/0/1|[counts](portable-compatibility/compatibility-counts.json)|
| Independent actual PostgreSQL16 final-admission/settlement |cb6 1pass/4fail → b8 5/5|[red](settlement-red.json), [b8](settlement-current.json), [same probe](settlement-probe.mjs)|
| Product continuity, HTTP/history cards, native tools and migrations |37/38; native-memory delivery failure retained|[product TAP](product-integration.tap)|
| Actual configured BGE + GLM two-phase path |0/1; missing background middle fact|[live TAP](product-live.tap), [counts](live-failure-counts.json)|
| Official browser, desktop/mobile, two-card forget/reload |3/3|[report](browser-report.json), [metadata](browser-run-metadata.json), [screenshots](screenshots)|
| New native self-deletion confirmation reproductions |0/2|[counts](self-deletion-current.json)|

The PG probe uses a new exclusive synthetic database on the existing local test service. It observes actual `pg_stat_activity` lock waits in both orderings, not only elapsed sleeps. Final-first prevents settlement before admission commit; record-first waits then rejects an already-settled call. Parallel reserve/record, lease expiry while waiting and actual-clock deadline expiry pass. Both independently built red and green databases were removed after closing their connections. No Docker changes, production database or live provider was used for these probes.

The legacy red is a **complete independent e8 build**, not the old handoff's mixed compiled-module stage. The b8 build was also complete. Scripts are byte-identical to handoff4c13; execution files record selected input hashes. Existing history/summary records remain intact; only invalid model projections are withheld.

Browser tests use the repository `tester-army/e2e`0.17.0 and official `@e2e-dev/web`0.12.0. The first launch executed zero cases because the default cache directory was absent. Reusing the environment's already-installed official Chromium cache resolved that infrastructure issue; no installation, isolation or security flags changed. The API/receipt fixture screenshots are synthetic. They are not represented as a browser-to-live-provider or production run. Mobile before/after images were visually inspected.

The first new self-deletion fixture incorrectly called AgentRuntime without the official worker review wrapper. No mutation committed, so those results are excluded from product findings. Its raw script/count hashes are preserved in VALIDATION.json. The corrected fixture uses `createWorker`; the actual mutation and confirmation assertions were not weakened. The independent original product failure predates this fixture.

## Source and release limits

Remote native main was `1e3493d46012ef9fc1747f102132ac599643bc19`; Loop main was `535873b941815b41961a44f56e479257cbb71626`. Loop main and `codex/release-213-218` at `f62c3b3` still pin3.5.6 and do not include PR224's memory continuity integration. PR224 remains draft atcef2349. The requested final combined product SHA has not been supplied; this review explicitly qualifies the PR224+b8 source pair, not an invented release combination.

The portable handoff reports final image535873b9 Worker startup failed with a bubblewrap permission error. This review did not repeat or change that Worker isolation gate. It remains a separately reported release blocker owned by the integrator/P0 workstream.

Native schema13/product0047 remain unchanged. Local owning migration tests pass, including preservation, active capture drain refusal, idempotent reapply and guarded rollback. After actual product0047/native13 installation, production recovery remains compatible fix-forward only. No production drain, migration/backfill, deployment, current production verification, formally published3.5.8 lockfile acceptance, final-image Worker acceptance or long soak is claimed here.

## Reproduction

All tests require Node22 and the already-installed locked development dependencies. Build exact upstream revisions independently. The source package is qualification only, never a production dependency substitute.

```sh
npm run build
node --test --test-concurrency=1 dist/test/runtime-diagnostic-privacy.test.js dist/test/memory-continuity-delete.test.js dist/test/memory-continuity-rollback.test.js dist/test/memory-rejected-tail.test.js dist/test/memory-model-admission.test.js dist/test/memory-admission-review.test.js dist/test/memory-history-projection.test.js dist/test/memory-legacy-snapshot.test.js dist/test/memory-session-forget.test.js
node --test --test-concurrency=1 dist/test/memory-context-budget.test.js dist/test/optional-memory-context.test.js dist/test/child-budget-admission.test.js dist/test/runtime-memory-privacy.test.js dist/test/model-execution.test.js dist/test/model-fallback.test.js
node --test --test-concurrency=1 dist/test/memory-continuity.test.js dist/test/memory-capture.test.js dist/test/memory-governance.test.js dist/test/memory-evolution-registration.test.js dist/test/memory-store.test.js dist/test/memory-synthesis.test.js dist/test/memory.test.js dist/test/semantic-memory.test.js
# Each JSON destination must be new; both probes emit only synthetic counts.
node docs/evidence/issue-216-final-review/settlement-probe.mjs /workspace/path-to-built-runtime /workspace/shared/new-settlement.json
node docs/evidence/issue-216-final-review/self-deletion-probe.mjs /workspace/path-to-built-runtime /workspace/shared/new-deletion.json
# self-deletion exits1 on b8; this is the retained acceptance failure.
```

Portable legacy commands are in the exact handoff4c13 README. Use `--expect red` only for the known e8 red and `--expect green` for b8. Product commands, from exact PR224 with the packed b8 public exports:

```sh
npm run server:typecheck
node e2e/server/memory-regression.mjs memory-continuity.test.ts memory-summaries.test.ts native-memory.test.ts migration.test.ts
OPENAI_EMBEDDING_MODEL=BAAI/bge-m3 EVAL_CANDIDATE_MODEL=zai-org/GLM-5.2 EVAL_CANDIDATE_INPUT_CNY_PER_MILLION=8 EVAL_CANDIDATE_OUTPUT_CNY_PER_MILLION=28 lingxi-prod model-run node e2e/server/memory-regression.mjs --live-continuity
# The two commands above fail as documented. Preserve their assertions and results.
./node_modules/.bin/vite build --config e2e/memory-privacy.vite.config.ts
./node_modules/.bin/vite preview --config e2e/memory-privacy.vite.config.ts --host 127.0.0.1 --port 52996 --strictPort
PLAYWRIGHT_BROWSERS_PATH=/workspace/.lingxi-setup/cache/ms-playwright E2E_MEMORY_PRIVACY_FIXTURE=1 E2E_BASE_URL=http://127.0.0.1:52996 E2E_BUILD_INDEX=artifacts/memory/site/e2e/memory-privacy.html npm run test:e2e:web -- e2e/web/memory-privacy.e2e.ts --output artifacts/issue216/browser-final-review-cached
```

Public TAP files retain case names and counters, with the two failure assertions; raw local logs remain hash-bound by [VALIDATION.json](VALIDATION.json). No raw provider prompt, private memory, credential or production record is included. Timing values describe these short executions only; no performance improvement or tail-latency claim is made.
