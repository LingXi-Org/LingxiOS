# Synthetic evidence

Base: formal upstream bbe5d4892ea1a805f5c923611bbd91d4320e472a (runtime3.6.0/native14).

- Failure model written before implementation: docs/public-purpose-failure-model.md.
- Initial red: 0/4 (no framing option, no rejection, same configuration identity, no v2 reader).
- Boundary red: same-frame cancellation continued to answer; EOF protocol failure lost observed usage. Both corrected, with context reservation for provider wire instructions.
- Capability red: no explicit reader capability. `releaseVersions.publicText=2` now advertises only reader support.
- Final build/typecheck: `node scripts/build.mjs` exit0, Node22.23.3.
- Final owning test run: **55/55**, 36.37s, `final-green.log`.
- Actual isolated PGlite application/Worker/native tool/event store/SSE/replay verifies typed commentary and answer parts, answer-only committed source, current auth, revoked audience, cancellation, fences and transaction replay. The additional forged-commentary-source case includes a matching body-hash candidate step and still cannot commit.
- Provider stream is a deterministic synthetic `fetchImpl` fixture. A callback gate proves answer A is delivered before the remaining escaped answer/EOF. No external provider, production, private data, SQL service, browser or credentials were used.

Reproduce after a local build:

```sh
node --test --test-concurrency=1 \
 dist/test/public-purpose.test.js dist/test/public-purpose-worker.test.js \
 dist/test/public-text.test.js dist/test/public-text-writer.test.js \
 dist/test/public-text-safety.test.js dist/test/public-text-acceptance.test.js \
 dist/test/public-text-storage.test.js dist/test/model-execution.test.js \
 dist/test/model-fallback.test.js
```

At the original code-review checkpoint there were no database migrations, native checksum changes, version bump or runtime publication. Subsequent authorized release preparation sets package/runtime3.7.0; publication and the exact product dependency pin remain release-owner work. See docs/public-purpose.md for the reader-first sequence and irreversible reader-compatibility boundary after v2 history is written.

Independent review follow-up: generic inputTokens initially double-counted protocol overhead in history/auxiliary estimates. `budget-red.log` reproduces history1026 vs42. Accounting now explicitly includes it once only for agent-turn context admission, primary/fallback admission and root reservation; structured/compaction and history remain unchanged. The added near-context-limit and root-reservation counterexample plus affected model/public-purpose suites passed **20/20** in4.22s (`budget-green.log`); final build/typecheck exit0. The preceding55-test run covers unchanged storage/safety/atomic-acceptance code. Total distinct owning cases:56. No larger test matrix was added.

Tool/answer correction: the old EOF restriction rejected a valid substantive answer plus native tool after that answer had streamed. `tool-answer-red.log` has two owning failures (tool executions0 vs1, adapter protocol rejection). The correction only removes that restriction and updates the producer instructions. `tool-answer-green.log` passes9/9 in2.77s, including a gated real native Worker/PGlite flow: answer durable before provider EOF, exactly one tool execution, four immutable purpose parts through SSE/replay, only the later final-answer source accepted. Existing malformed, cancel, usage and legacy cases in that same small suite passed. No full suite or external provider was rerun locally. Loop added its existing three-case projection suite to prove current tool-turn answer foreground routing and later identity supersession; product projection code required no change.
