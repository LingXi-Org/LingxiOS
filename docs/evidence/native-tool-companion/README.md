# Validated native tool turns with unpublished companion prose

Base: `582e633b25395d2c791f6bb559fa0ee04c43dccb`. Package version remains the unreleased 3.8.6. All evidence below uses synthetic wire responses and local fixtures, with no live provider or production input.

## Behavior

An explicitly configured `jsonObjectWithTools: false` driver can receive ordinary prose together with valid native `tool_calls`. Previously, purpose parsing rejected the prose before consuming the tool call and the final usage frame. The compatibility path consumes the response, validates the entire native call batch, and returns only the tool calls plus measured usage. The untyped text is never streamed, stored in assistant history, treated as an answer, or used as completion evidence. Diagnostics retain the fixed `unpublished_tool_companion` classification, without text.

Compatibility is deliberately conservative: only letter-led plain prose (including Unicode letters) qualifies. JSON objects, arrays, scalars and markup wrappers remain strict. No-tools final answers, structured content once framing has started, unknown or incomplete calls, invalid argument JSON, conflicting IDs, unsupported parallel batches, abnormal finishes, cancellation and output bounds cannot use this path. Actual argument-schema validation, authorization, approval, idempotency and receipts remain in the existing runtime/executor. No retry or budget limit changes.

The applicable purpose/profile configuration fingerprint now includes `unpublished-native-prose-v1`. Existing default structured profiles retain their fingerprint. A release must drain or honor old runtime bindings; this change must not be presented as the old opted-out policy.

## Verification

The [failure model](../../native-tool-companion-failure-model.md) and new tests preceded implementation. The initial 26 driver checks had 19 failures: valid native calls were rejected, and the early error omitted later measured usage. The two initial Worker regressions reached no tool execution/authorization. A later independent review found JSON scalar framing; four added negative regressions failed before that boundary was corrected.

- 106 relevant compiled regressions passed: driver protocols, model execution and accounting, cancellation/deadlines, child budget admission, protocol recovery, and formal Worker flows.
- After the scalar-framing and EOF-cancellation accounting corrections, all 41 affected driver/model-execution checks passed, and TypeScript compilation passed again.
- The final classification-only correction keeps unframed final answers and JSON scalar framing in `public_text_invalid` / `response_protocol`, while invalid tools remain tool-protocol failures. Its regression failed first; all 55 affected driver, protocol-recovery and model-execution checks plus TypeScript then passed. Acceptance boundaries and the shared correction budget are unchanged.
- The new formal Worker scenarios use isolated PGlite and the actual worker/executor. Both issue exactly two model calls and settle two measured usage records. An authorized tool executes once, then a strict final answer succeeds; denied authorization executes zero tools and preserves a blocked outcome. A further worker poll does not replay the completed work.
- Existing substantive structured text still streams before provider EOF; malformed structured output remains a failure. Default configuration fingerprint regressions remain green.

Reproduction: `npm run build`, then Node's test runner with `--test-concurrency=1` over `dist/test/native-tool-companion*.test.js`, `purpose-native-tools`, `public-purpose*`, `protocol-recovery*`, `model`, `model-execution`, `model-operation`, and `child-budget-admission` tests. The new companion and model-execution tests can also run directly through the existing TypeScript test loader.

This is not a live-provider completion-rate result or a deployment receipt. Formal release, exact-head CI and the final independent review are separate integration gates.
