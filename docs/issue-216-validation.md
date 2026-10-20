# Issue 216 native qualification

Both phases belong to one delivery. This contributor supplies native source and Loop draft PRs; the sole integrator owns coordinated publication, exact dependency pins, deployment and issue closure.

Base: `e44fb862c1a1a0d94eb5213fcfaf56f3dfccae73` (3.5.6/schema12). Candidate schema13 is installed through packaged 015. Runtime package version is intentionally unchanged pending one official release coordinated with issues 215/218; suggested compatible minor is 3.6.0. Source tarballs are development qualification, never release artifacts.

## Results

Node 22.23.3, local PGlite and isolated PostgreSQL. Original memory/embedding baseline: 48/48, 131097 ms. Expanded memory/semantic/embedding/collaboration/runtime/privacy/background suite: 163/163, zero skips, 199347 ms. The subsequent fixed-dimension embedding contract was separately verified 3/3 in 640 ms. Build passed. Deterministic model/provider fixtures are not evidence of real provider quality.

```sh
npm run build
node --test --test-concurrency=1 dist/test/memory*.test.js dist/test/semantic-memory.test.js dist/test/embeddings.test.js dist/test/collaboration.test.js dist/test/runtime.test.js dist/test/runtime-memory-privacy.test.js dist/test/background-scheduler.test.js
```

Public APIs added: trusted `MemoryScopeGrant` continuity/readOnly/explicitOnly/legacyScope; `memory.migrateLegacy`; `memory.reindex`; independent memory context allocations and sanitized diagnostics; `EmbeddingOptions.indexVersion` and `expectedDimensions`; immutable `schema012`, `migration015` and guarded `rollback015` package resources. Plain old scope consumers retain their previous IM partitioning. `expectedDimensions` validates fixed output without transmitting a dimensions parameter, while requested and fixed identical dimensions share vector-space identity.

Failures reproduced and corrected include prefix-only long-source capture, cross-room scope identity, queued request revisions preceding the first fenced step, duplicate index admission, JSONB snapshot digest order, deleting a second historical card after an epoch advance, protected/invalid model proposals, fixed-size provider HTTP400, and diagnostic payload copies. One synthesis repair precedes independent review and remains inside the same ledger, deadline and cancellation budget. No protected write is silently accepted.

Memory diagnostic events contain references/counts rather than bodies or provenance. Both optional raw-payload trace switches are suppressed for memory-capable runs, including later tool-history calls. Authorized model inputs, sessions and action receipts retain their original business content. Unknown extension errors and background error callbacks expose a generic failure; known native errors retain fixed typed messages. Existing stored event rows are not rewritten or deleted; this change protects new writes and current product rendering, not historical storage erasure.

Cross-repository product, configured-provider and browser evidence is tracked in [Loop PR224](https://github.com/LingXi-Org/LingxiLoop/pull/224). Formal dependency/lock qualification, production drain/migration/backfill, exact-image CI and deployment remain integrator gates. No production data was modified.
