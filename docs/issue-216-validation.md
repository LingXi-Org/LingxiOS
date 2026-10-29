# Issue 216 native qualification

> Historical release record: older producer protocols and migration resources described here are no longer provided by the current package. See [current upgrade instructions](packaged-runtime.md#installation-and-versions).

Both phases belong to one delivery. This contributor supplies native source and Loop draft PRs; the sole integrator owns coordinated publication, exact dependency pins, deployment and issue closure.

Base: `e44fb862c1a1a0d94eb5213fcfaf56f3dfccae73` (3.5.6/schema12). Candidate schema13 is installed through packaged 015. Runtime package version is intentionally unchanged pending one official release coordinated with issues 215/218; suggested compatible minor is 3.6.0. Source tarballs are development qualification, never release artifacts.

## Results

Node 22.23.3, local PGlite and isolated PostgreSQL. Original memory/embedding baseline: 48/48, 131097 ms. Expanded memory/semantic/embedding/collaboration/runtime/privacy/background suite: 163/163, zero skips, 199347 ms. The subsequent fixed-dimension embedding contract was separately verified 3/3 in 640 ms; synthesis/embedding/collaboration updates passed 28/28. The real capture queue/scheduler/JSON sink plus synthesis checks passed 11/11 in 36983 ms, including assistant-only continuation progress. Build passed. Deterministic model/provider fixtures are not evidence of real provider quality.

```sh
npm run build
node --test --test-concurrency=1 dist/test/memory*.test.js dist/test/semantic-memory.test.js dist/test/embeddings.test.js dist/test/collaboration.test.js dist/test/runtime.test.js dist/test/runtime-memory-privacy.test.js dist/test/background-scheduler.test.js
```

Public APIs added: trusted `MemoryScopeGrant` continuity/readOnly/explicitOnly/legacyScope; optional fourth resolver operation argument (read/write/capture); `memory.migrateLegacy`; `memory.reindex`; independent memory context allocations and sanitized diagnostics; `EmbeddingOptions.indexVersion` and `expectedDimensions`; immutable `schema012`, `migration015` and guarded `rollback015` package resources. Plain old scope consumers retain their previous IM partitioning, and old three-argument resolvers still work. The operation hint lets the product skip unrelated write-permission queries on reads while preserving before/after read authorization. `expectedDimensions` validates fixed output without transmitting a dimensions parameter, while requested and fixed identical dimensions share vector-space identity.

Failures reproduced and corrected include prefix-only long-source capture, cross-room scope identity, queued request revisions preceding the first fenced step, duplicate index admission, JSONB snapshot digest order, deleting a second historical card after an epoch advance, protected/invalid model proposals, fixed-size provider HTTP400, and diagnostic payload copies. One synthesis repair precedes independent review and remains inside the same ledger, deadline and cancellation budget. No protected write is silently accepted.

Memory diagnostic events contain references/counts rather than bodies or provenance. Both optional raw-payload trace switches are suppressed for memory-capable runs, including later tool-history calls. Authorized model inputs, sessions and action receipts retain their original business content. Unknown extension errors and background error callbacks expose a generic failure; known native errors retain fixed typed messages. Existing stored event rows are not rewritten or deleted; this change protects new writes and current product rendering, not historical storage erasure.

Cross-repository product, configured-provider and browser evidence is tracked in [Loop PR224](https://github.com/LingXi-Org/LingxiLoop/pull/224). Formal dependency/lock qualification, production drain/migration/backfill, exact-image CI and deployment remain integrator gates. No production data was modified.

Final bounded-page/synthesis checks passed 11/11 (63059 ms). Configured BGE1024/GLM-5.2 acceptance in Loop passed 1/1 (68495 ms), including explicit and automatic long-input middle/tail facts, effective revisions and actual new-room input/answers, hybrid current-version vectors, complete cursors and forget/index removal. Its 34 actual provider requests all returned HTTP200; the shared ledger recorded 34 measured calls, including 10 embedding calls, costing 339003 micros under the configured conversion. Current-main product checks passed 5/5; official browser checks passed 3/3. These are source qualifications using the npm-packed native source, not a published-release or production acceptance claim.
