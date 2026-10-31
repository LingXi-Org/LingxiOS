# Slides final-answer suspension / seal rejection

Maintenance source: v3.8.20, bc594a2c93d439de1aefcf7efd8fc4841cf73dc3. No 4.0 code or product-side runtime replacement.

The reported production sequence had an append answer, four deltas, an interrupted end, then seal/persistence_rejected and no sealed source or result. The original rejected text/cause is not copied here. Published3.8.20 reproduces the same sequence when its bounded preview pauses an uncertain suffix for one second: suspend closes the answer as interrupted, but runtime later attempts to seal the final model answer. The unchanged store correctly accepts seals only after completed/tool, rejecting that source. This identifies a matching, reproducible defect; persistence_rejected alone does not identify all storage/policy failures.

The patch keeps a suspended v3 answer open while dropping its unapproved buffer. EOF must pass the complete existing safety policy and the200KB byte bound. The already-acknowledged prefix is verified with its incremental hash and character length; only the final approved suffix is appended. There is no second unbounded text buffer, weakening of the store guard, automatic provider retry, rewrite of a sealed/closed source, or success fallback. Commentary and older protocols retain interrupted-preview behavior.

Tests use synthetic content, actual SDK publication/Worker code and PGlite persistence; no provider calls or production writes. They cover real durable seal after suspension, native-v3 output binding, tampered-prefix rejection, unsafe EOF, byte bounds, real seal-storage rejection, saved synthetic page preserved with a failed turn/no result, ordinary question completion, normal cross-tool append, failed-protocol replacement, repeated correction and replay/lineage. Test outcomes belong to the PR and release-gates run. These are not production E2E or proof that every persistence_rejected has this cause.

Useful commands after npm ci --ignore-scripts and npm run build:

    node --test --test-concurrency=1 dist/test/public-text-suspension.test.js dist/test/public-text-storage.test.js dist/test/react-segments-runtime.test.js
    node --test --test-concurrency=1 dist/test/answer-correction.test.js dist/test/corrections.test.js dist/test/public-text-writer.test.js dist/test/public-text-safety.test.js dist/test/native-tool-public-output-worker.test.js
    node --test scripts/test-answer-candidate-lineage.mjs scripts/test-correction-candidate-view.mjs

Release impact: this source patch is not a published package; package version is deliberately unchanged pending coordinated release preparation. A new formal3.8 maintenance release, exact archive/integrity qualification, and Loop's reviewed product61 runtime20→new-version provenance path are required before adoption. Loop currently hard-pins3.8.20 and migration61 explicitly requires it. Native14/protocol11 and product61 data should stay unchanged. Do not publish over3.8.20, substitute this checkout for the product dependency, relax provenance checks, or roll product61 back to a product60-only binary. Existing failed attempts stay audit records; the patch does not rewrite them or erase their saved files.

Observed local results on 2026-10-31: TypeScript build passed;36/36 focused suspension/storage/Worker cases,27/27 safety/native/correction cases,16/16 failed-candidate lineage/view checks. In the original installed formal3.8.20 writer, the same real-store fixture failed with seal/persistence_rejected caused by “only a complete answer segment can be sealed”; the patched fixture passed. Native-v3 paused-answer Worker, one/two consecutive failed-protocol drafts, ordinary answer, cross-tool append, and saved-page/failed-seal cases all passed. CI/release qualification is separate; these numbers do not claim full release gates or production acceptance.

The final fix also awaits the in-flight append chain before checking the acknowledged-prefix hash. A controlled delayed ACK plus timer suspension reproduced duplicate prefix characters in the initial proposal; this regression now passes without weakening the seal hash check. Final local checks:36/36 +27/27 +16/16, build passed.
