# Protocol decoding and bounded recovery

Related: [LingxiLoop #332](https://github.com/LingXi-Org/LingxiLoop/issues/332).
Failure inventory was written before implementation in
[`../../issue-332-protocol-failure-model.md`](../../issue-332-protocol-failure-model.md).

A production public diagnostic reported a protocol failure after a normal `stop`,
then delivered `model_unavailable`. The exact malformed field and original SSE
bytes were not exposed. No original task was replayed, and no private response,
conversation identifier, raw trace or credential is included here.

The local deterministic defect is in SSE framing: the delimiter expression
accepts CRLF/LF (three characters), but the old decoder advances four characters
when it starts with CR. If the next event is buffered already, its `data:` loses
its initial `d`; the event is silently discarded. A valid three-frame purpose
answer then becomes incomplete. The fix consumes the matched delimiter length.
LF/LF, CRLF/CRLF, CRLF/LF and LF/CRLF are exercised at every network split; the
real HTTP driver also verifies complete answers in buffered and one-character
network chunks. This matches a possible production failure shape, not a proven
original wire cause.

Two recovery defects were also reproduced. Public text framing/empty-answer
failures previously received a tool-protocol correction; now fixed local reason
codes select an explicit purpose JSON correction requiring a substantive answer
or a genuinely needed authorized native tool call. Observed finish reasons now
survive a parser exception even without measured usage. Persistent protocol
failure maps to `execution_failed`, with its allowlisted protocol diagnostic;
real HTTP provider failure remains `model_unavailable`.

The parser still rejects duplicate/reordered keys, trailing text, invalid escapes,
unpaired surrogates and oversized framing. There is no raw-text fallback. Shared
correction limits, root model budgets, cancellation, authorization and effect
execution are unchanged. The parallel #331 budget work is integrated separately
before one formal runtime publication.

## Validation

- Build/typecheck passed on Node 22.23.3.
- New protocol checks: **18/18 passed**, recorded in
  [`protocol-recovery.tap`](protocol-recovery.tap); source hashes are in
  [`source-hashes.json`](source-hashes.json).
- Existing owning regressions: **28/28 passed** across `public-purpose`,
  `public-purpose-worker`, `public-text-worker-boundaries` and
  `runtime-diagnostic-privacy`, including cancellation, safe publication failure,
  strict framing, channel isolation, usage settlement and public privacy.
- Real worker + PGlite + HTTP-driver fixtures: empty answer and incomplete frame
  recover in two generation calls. A completed native tool survives a later
  malformed response and correction: three generation calls, one review, exactly
  one authorized tool execution, final `succeeded`, all four reservations settled.
- Persistent malformed output stops after three generation calls under the
  existing two-repair cap. HTTP 503 remains a single provider attempt in its
  explicitly single-attempt fixture.

Initial red runs reproduced the decoder, public correction and terminal mapping
failures. Two test setup mistakes were corrected separately: HTTP failures do not
always populate `kind`, and the tool fixture must expose its tool in execute mode
while explicitly declaring text delivery. Those fixture errors are not product
bugs. No assertion was relaxed to accept a partial final result.

Reproduce from the repository root:

```sh
npm ci --ignore-scripts
npm run build
node --test --test-concurrency=1 dist/test/protocol-recovery.test.js dist/test/protocol-recovery-worker.test.js
node --test --test-concurrency=1 dist/test/public-purpose.test.js dist/test/public-purpose-worker.test.js dist/test/public-text-worker-boundaries.test.js dist/test/runtime-diagnostic-privacy.test.js
```

These synthetic cases prove concrete behavior, not a population completion rate
or original private-case acceptance. Exact-head CI, formal package publication,
product dependency integration and production release remain separate gates.
