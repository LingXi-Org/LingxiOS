# Configurable content correction allowance (LingxiLoop #331)

Written before tests and implementation. LingxiLoop's sanitized production evidence identifies an incomplete answer ending `partial/inconclusive` with content acceptance corrections exhausted. It does not establish the exact sequence that consumed the allowance. Synthetic fixtures must not be presented as the original conversation.

- Existing hosts keep the default shared allowance of two continuations. Only trusted runtime/Worker configuration may add zero through three content corrections; prompts, model output, and work metadata cannot select the allowance.
- Two protocol errors can consume the default allowance before a valid but incomplete candidate. With three additional content corrections, a semantic review must be able to request and obtain the missing answer within the existing root resources.
- Repeated omissions must still terminate with an honest partial result. The added allowance applies only to content acceptance; kernel failures and lifetime protocol repairs retain their existing limits.
- New observations retain their existing reset semantics. Repeated observations, incidental timestamps, and replay must not manufacture progress. Shared checkpoint count stays within zero through six, and restoration must not replenish spent corrections.
- Non-default allowance is part of the durable runtime behavior binding. Resuming a bound run under a different value must stop before issuing another model call. Omitting the option and explicitly setting zero remain compatible with existing bindings.
- Hosts without a harness must bind nonzero allowances too. An older unbound execution with a checkpoint cannot acquire additional corrections during upgrade; it must resume with the default allowance. This conservative rule also covers a checkpoint saved immediately before a provider call.
- Cancellation, lease loss, authorization, human blockers, trusted handoffs, and unknown-effect reconciliation remain stronger than the allowance. Additional content repairs cannot authorize or repeat a tool side effect.
- All generation and review attempts remain charged to shared call/token/cost/execution-time limits. The allowance is not a promise of five total run calls: an individual correction may require several model/review calls, and real progress can reset the shared continuation counter.

Validation uses the existing in-memory runtime, durable budget/step fixtures, and owning budget/recovery suites; no provider, external data, shared database, or permission expansion is required.

## Validation receipt (2026-10-23)

- Before implementation, `npm run build` passed, then the initial 14-test conversation suite had 8 passes and 6 behavioral failures: the configured repair did not execute, persistent omissions stopped at the old limit, root-budget termination was not reached, the recovery checkpoint was not reached, changed configuration still called the model, and invalid configuration was accepted.
- Before the no-harness binding fix, its two new runtime tests both failed: no configuration binding was stored, and an existing unbound execution acquired additional corrections on resume.
- After implementation, build and typecheck passed. The command below passed all 64 tests in 8024.894462 ms, with zero failures, cancellations, or skips. `git diff --check` passed.
- The successful synthetic case makes four generation attempts (two typed protocol failures, one incomplete candidate, one substantive explanation with numeric examples) and three review calls. Persistent omissions stop after six generation attempts and eight review calls. Each of the four root resource limits stops the configured run after exactly five settled model calls, before another generation; cancellation also prevents that next generation. Restoration at shared count four does not replenish it.
- Owning tool-recovery tests retain authorization checks and exactly one committed effect/receipt after an acknowledged transaction rollback, and reject retry of unknown effects. No new permission or tool-effect behavior is introduced.

```sh
npm run build
npm run typecheck
node --test --test-concurrency=1 \
  dist/test/conversation-content-repair.test.js \
  dist/test/corrections.test.js \
  dist/test/model-execution.test.js \
  dist/test/reliability.test.js \
  dist/test/harness-v3.test.js \
  dist/test/tool-failure-recovery.test.js \
  dist/test/tool-recovery-transaction.test.js \
  dist/test/terminal-results.test.js
git diff --check
```

The timings above measure local synthetic tests, not provider latency. An extra correction can require generation plus multiple reviews, all charged to the same root budget. The original production call sequence remains unconfirmed. Real visualization save/read delivery, provider behavior, and production completion-rate acceptance belong to the consuming product after a formally published runtime is adopted by the sole publisher. No package version, lockfile, schema, historical record, or deployed state was changed here.
