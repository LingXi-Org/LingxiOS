# LingxiLoop #406 — correction answer operations

Base: `4ef5ebad7ad2c22c752394763b09b987842be9f0` (formal 3.8.11 source). Product issue: https://github.com/LingXi-Org/LingxiLoop/issues/406. This is an upstream source candidate only; no version/lock change, package publication, product dependency override, schema change or deployment.

A runtime-requested correction could seal another append over the candidate being repaired. The final v3 commit then correctly retained both sources, so product projection could not safely guess which full answer to remove. The runtime now supplies a precise replacement operation for the current sealed candidate and rejects a different operation before any substantive correction delta and again before sealing non-streaming/custom output. It does not rewrite the model's declared operation, deduplicate text or add a judge/model call.

Ordinary generations and A → business tool → B continuations retain their declared append behavior. During a runtime-requested repair, any new substantive public answer is the complete corrected candidate and must explicitly replace all current candidate source IDs in order. Commentary, necessary business tool calls and an already-valid terminal null body retain their existing contracts and validation. The repair intent is an ordinary fenced `runtime.answer_correction` step, deduplicated by request/source identity; it survives a lost acknowledgement and business-tool continuation. A valid replacement seal changes active source IDs and retires that intent without another write; a human request revision clears it. Existing seals, call/usage records, source IDs, cancellation and failed-replacement fallback remain intact.

Validation on Node 24.19.0 with `npm ci --ignore-scripts` and the committed lock:

- `npm run build`: passes, including production/test TypeScript and declaration generation.
- `node --test --test-concurrency=1 dist/test/answer-correction.test.js dist/test/public-answer-tool-worker.test.js`: 20/20 pass, zero failed/skipped. Covers normal one-generation answer, A/tool/B append, explicit repair replacement, invalid append rejection before public text/seal, metered failed call, durable repair through lost ACK/restart/tool, original failed-replacement retention, cancellation and existing sealed-call recovery/tamper boundaries.
- A focused 3/3 artifact run passes, producing the adjacent JSON files. They contain observed per-attempt operation/delta/seal events, unchanged model-call ledger entries and final source descriptors. The wrong append may have an empty public operation event, but has no public answer delta and no seal. Its model invocation remains metered. All three final bodies contain exactly the corrected answer, with one accepted segment; business effects and auxiliary calls are recorded separately.
- `git diff --check`: passes. No extra independent review or full suite was run, per the task's current instruction.

Initial local build failed on optional v1/v2 operation fields in the streaming guard; narrowed the identity before validation and rebuilt successfully. Initial 18/18 passed before adding durable repair recovery; final 20/20 covers that addition. PGlite emits outbox acknowledgement warnings when the synthetic fixture closes; asserted durable records and test outcomes remain as captured. No live provider or real user material was used. Browser/production original-case acceptance remains outside this synthetic Worker proof.

Reproduce machine records:

```
npm ci --ignore-scripts
npm run build
ISSUE406_EVIDENCE_DIR=/tmp/loop406-evidence node --test --test-concurrency=1 --test-name-pattern='requested correction|appended full rewrite|repair intent survives' dist/test/public-answer-tool-worker.test.js
```

Release handoff: the main coordinator must merge/publish a formal version through the existing release process, then update LingxiLoop's exact dependencies/locks and provenance through its owning release task. Do not treat this source branch or an unpacked local build as a published production runtime. The independent product terminal-feedback change is LingxiLoop PR #416 and does not require this source candidate to describe existing 3.8.11 typed diagnostics.
