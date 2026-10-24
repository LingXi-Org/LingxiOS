# Independent native public-answer failure model

This suite tests the actual OpenAI driver and durable Worker with local scripted SSE only. It does not call an external provider, evaluate production conversations, or qualify real-model latency. The implementation owner owns source; the independent test author owns the two new test files.

## Required boundaries

| Trigger | Required result | Owning coverage |
| --- | --- | --- |
| Explicit public-answer capability | Add one dedicated native output tool; preserve every business schema/name; version the behavior fingerprint | driver catalog / clone / private opt-out |
| Ordinary arithmetic | One generation, one terminal answer, no business dispatch or auxiliary review | driver and Worker |
| Known explanation then resource work | Useful typed text streams before the public tool arguments close; seal only after the complete valid turn; continue through the existing loop, save once, then append final verified result | streaming driver and durable Worker |
| Tool name or call ID arrives late | Buffer until identity is complete; do not publish from unresolved identity; preserve raw call identity and arguments in future history | fragmented driver and recovery Worker |
| Unicode/escape split at any argument boundary | Decoded answer is exact, without replacement characters or repeated text | driver fragmentation |
| Plain companion or reasoning | Never promote it to a public answer; the explicit public tool is the only new typed source | driver |
| Public plus business tool, two public tools, duplicate IDs, late identity mutation | Validate the original complete native batch; reject before dispatch or seal, even when a provisional prefix was already observed | driver and Worker |
| Late extra field, incomplete JSON, bad finish or cancellation | No accepted public result, no business effect, no sealed source for the invalid attempt | driver and Worker |
| Replacement fails validation | Previously valid sealed body remains intact; invalid replacement cannot become a final source | Worker |
| Seal transaction succeeds but its response is lost | Resume from the real native seal step; restore the original public native call plus acknowledgment once; do not repeat a body, generation, business effect or fake business receipt | Worker with real PGlite stores |
| Compaction removes model-history calls but keeps sealed sources/cursor | Reused native call identity is rejected before any new durable seal; retained valid sources remain recoverable | Worker at the persisted history boundary |
| Seal recovery call disagrees with durable public text | The existing seal transaction rejects the mismatch and stores neither a seal event nor a recovery step | Worker with host-event corruption injection |
| Another request/run uses the same provider call ID | Do not revive archived public calls as current work; each run owns independent answer source identity | Worker |
| Explicit final outcome with sources | Existing whole-body citation/resource/delivery validation still runs; null terminal requires a valid nonempty sealed set | Worker |
| v2/private or capability absent | No new output tool, no changed historical binding, no new semantics | driver clone/opt-out |

## Reuse and evidence

Use the existing `OpenAIChatDriver`, its public-purpose parser, the original tool-batch validator, `createWorker` and PGlite schema. Reuse the repository's serialized PGlite pool and lease-loss fixture pattern from `react-segments-runtime.test.ts`; do not simulate sealing, append/replace reduction, authorization or recovery in the test. Existing production code retains the directly imported LangChain/LangGraph primitives. Tests inspect actual outbound request bodies and durable events/steps instead of reconstructing a parallel implementation.

Run the new owning cases against the unchanged baseline compiled runtime before rebuilding the implementation, retaining compile-only failures separately. Successful local tests establish deterministic boundary behavior only. They never turn the earlier failed real-provider qualifications into passes, and they do not authorize a new provider call or production operation.

## Baseline and fixture corrections

The unchanged c5 baseline ran 32 new cases: 16 failed and 16 passed. The failures cover missing native public output, early streaming, configuration identity and durable Worker behavior. A first test-only transpilation attempt emitted CommonJS into the ESM tree and failed at startup; it is retained separately and is not counted as behavioral red evidence.

The first implementation run passed 30 of 34 cases. It exposed the typed-content conflict boundary and the need to include the latest transaction validation in the built candidate. Two fixture assertions counted all runtime action intents as business tools; they were corrected to inspect the exact action names, while preserving provider-call, meter, dispatch and effect counts. Runtime internal intents are not evidence that the public output binding dispatched a business action. The later compaction case explicitly targets `session.request.publicTextHistory`, preserving the actual sealed step and cursor while clearing only compacted model-history items.
