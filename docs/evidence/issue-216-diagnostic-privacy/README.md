# Diagnostic privacy correction

Related to LingxiLoop #216. Base `627e6627e03512f5314e621471eeb6bc50ffadfa`; code commit `eb0d7682200a762aeda2119a9ba3dbc67c4bc53c`. This is an isolated correction to PR33, pending integration and release by the release owner. Package metadata remains 3.5.6; no package, schema, migration or dependency lock was changed.

Returned failed/unknown memory receipts copied their original errors into user tool events. Generic model errors without memory capabilities, nested driver diagnostics and heartbeat lease-loss logging also copied arbitrary content. The correction changes these diagnostic copies: fixed failure messages, fresh allowlisted model metadata, and fixed lease-loss log detail. It also applies the same metadata boundary to `model.completed`. Original driver errors, recovery classification, usage accounting, protected action receipts, session/step output and authorized model input remain intact. Unknown outcomes still require reconciliation.

## Reproduction and results

The failure model and first ten runtime cases were written before implementation. At the base, the final fixture produced **7 failures and 3 passes**. Two additional metadata boundary cases were added with the implementation. After the correction, **12/12 focused tests** and **127/127 owning tests** passed; build/type compilation passed. `validation.json` records source and log hashes.

All executions used Node 22.23.3 and local synthetic data. The runtime and `PgEventStore` serializer are real; the latter writes into a parameter-capturing SQL adapter, **not a PostgreSQL server**. The provider case uses the actual `OpenAIChatDriver` with synthetic fetch. No live provider, production request, database connection, credential creation or long soak occurred.

Independent original probes were rerun unchanged apart from their compiled import prefix. Their `kind` labels retain older candidate names from the original fixture; those labels do not identify the executed source. The source identity here is the base/code commit above, with probe adaptation hashes in `probe-provenance.json`.

| Same-fixture probe | Baseline marker copies | Candidate marker copies |
| --- | --- | --- |
| Returned failed memory tool, event / serialized event | 1 / 1 | 0 / 0 |
| Returned unknown memory tool, event / serialized event | 1 / 1 | 0 / 0 |
| Generic model error without memory, event / serialized event | 1 / 1 | 0 / 0 |
| Nested driver diagnostics, event / serialized event | 1 / 1 | 0 / 0 |
| Actual OpenAI driver unknown finish reason, event / serialized event | 1 / 1 | 0 / 0 |
| Heartbeat error logger, before any model call | 1 | 0 |
| Authorized model input / protected step, each returned memory receipt | 3 / 2 | 3 / 2 |
| Explicit no-memory raw trace opt-in, event / serialized event | 1 / 1 | 1 / 1 |

Successful memory events remain content-free. A thrown host error has no returned receipt: it still fails without inventing `tool.completed` or storing a fabricated receipt. An initial test incorrectly expected a saved output for that path; it was corrected before the final baseline run. Two earlier fixture compilation errors and that invalid assertion were not counted as product failures.

Classification, valid stop/tool/length reasons, HTTP status and usage remain available. Unknown finish reasons become the diagnostic enum `unknown`, not success; the actual driver still fails that response with its original error/accounting. Event correlation IDs and arbitrary extension fields are omitted; the existing structured recovery ledger is unchanged. Explicit raw trace opt-in is a positive compatibility control, not a default-diagnostics claim.

## Commands

```sh
npm run build
node --test --test-concurrency=1 dist/test/runtime-diagnostic-privacy.test.js
node --test --test-concurrency=1 \
  dist/test/runtime-memory-privacy.test.js dist/test/runtime.test.js \
  dist/test/model.test.js dist/test/model-recovery-metadata.test.js \
  dist/test/model-execution.test.js dist/test/model-fallback.test.js \
  dist/test/terminal-results.test.js
```

Tests used existing read-only dependencies without installation. The baseline and candidate probe JSON files contain counts only. This correction applies to new emissions; it does not rewrite historical diagnostics. Integration with the concurrent runtime public-text changes, final exact-head CI, formal package publication and product validation remain release-owner gates. Real-provider acceptance, PostgreSQL persistence behavior and production fault matrices were not newly tested here.
