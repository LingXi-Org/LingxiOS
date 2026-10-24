# #366 upstream reuse decision — 2026-10-23

Decision: use the two public server-side APIs directly behind a trusted LingxiOS adapter. Do not create StateGraph, ToolNode, a second checkpointer, tracer or model loop. Native tenant/run fences, cancellation, budgets, side-effect receipts and atomic commit remain the only execution authority. This is an integration decision after exercising the actual packages, not a claim that their APIs cannot be safely adapted.

## Locked public packages and executable evidence

- `@langchain/core@1.3.0`: `sha512-ZiS8USsHdO8ZVFh0m8Rs6v2BvqBEvfFicG66zxdF4rGgXSJjk0d0sLnnFZCx3RXPUvP8ybTJgPlNfkJGs1J7BA==`
- `@langchain/langgraph@1.5.2`: `sha512-jfVB9x+FH3CqlOYsYSVyuBoElV/J9pRL2nb7gie9Fb53J6rwNxSjTwxtyH3N8eVbZ94QckuFRxom6KTMlFfMOQ==`
- Probe and complete resolved lock: `/tmp/react-harness-import-probe/probe.mjs`, `package-lock.json`. Installation used `--ignore-scripts --no-audit --no-fund --save-exact`, no shared node_modules mutation. 22 installed packages, 73 MiB disk use. Published unpacked sizes: core 7,643,106 bytes; graph 4,567,515 bytes (not bundle sizes). Actual probe Node v24.19.0. Engine minima core >=20, graph >=18; application Node baseline remains independently enforced.
- Public imports: `AIMessage`, `AIMessageChunk`, `RemoveMessage` from `@langchain/core/messages`; `messagesStateReducer` from `@langchain/langgraph/web`.
- Probe exit 0: replacement in existing logical position; explicit remove plus append; input array unchanged; repeated identical logical update adds no item; equal text with different IDs remains distinct; unknown remove throws; raw whitespace and Unicode survive concat; same-turn content and fragmented tool calls both survive. Global fetch replaced with throwing counter before dynamic imports: observed calls = 0. This checks these import/functions, not every package code path or network API.

## LangGraph source reuse

Pinned source: https://github.com/langchain-ai/langgraphjs/tree/c6675bf03f353ff32fb2ee0a82adb3541c0aee40

- `libs/langgraph-core/src/graph/messages_reducer.ts:99` exports `messagesStateReducer`; id-index stable merge core at 137–165. Array coercion, random missing IDs and remove-all are outside the adapter's allowed input domain.
- Tests `libs/langgraph-core/src/graph/messages_reducer.test.ts`: add 15/26, same-ID update 41, duplicate input 59, remove/replacement 71, unknown remove 109, mixed operations 117. `message.test.ts:10` separately requires ID for graph stream publication.
- MIT license: https://github.com/langchain-ai/langgraphjs/blob/c6675bf03f353ff32fb2ee0a82adb3541c0aee40/LICENSE (Copyright 2024 LangChain). Normal package distribution retains its license; any later copied/adapted kernel must retain notice. No kernel has been copied into product code here.

Trusted adapter: host emits stable logical `segmentId`; each attempt/revision has a separate immutable `revisionId`/part ID. Append uses a fresh logical ID. Validated replacement creates a new AIMessage with the first affected logical ID and removes any other explicit affected IDs from the active projection. Old sealed revision records remain immutable. Normalize first replacement target by existing active order or reject noncanonical target order; never let model array order silently move answer text. Require active revisions, current run/request/fence, exact hashes/ranges and same operation identity before constructing RemoveMessage. Reject missing IDs, unknown/all-removal sentinel, duplicate targets, conflicting replay and cross-run revisions. Reducer last-write-wins is not an authorization or idempotency policy.

## LangChain chunk reuse

Pinned source: https://github.com/langchain-ai/langchainjs/tree/38eb4d8f08b13a36b7d79c976bbdc56e250d87de

- `libs/langchain-core/src/messages/ai.ts:477` `AIMessageChunk.concat` preserves text and tool-call chunks, carries first defined ID, combines metadata and usage.
- Tests `libs/langchain-core/src/messages/tests/ai.test.ts:433` tool call delta collapse, `:665` distinct calls, `:729` matching call index, `:772` fragmented calls, `:876` fragmented server-tool content.
- MIT: https://github.com/langchain-ai/langchainjs/blob/38eb4d8f08b13a36b7d79c976bbdc56e250d87de/LICENSE

The adapter must deduplicate event sequence before concat; concat itself repeats strings and sums usage. Enforce expected attempt ID and monotonic sequence first. Use explicit public-purpose parsed text only, never arbitrary contentBlocks/reasoning/additional_kwargs. Freeze usage once from authoritative metering; do not republish duplicated merged usage as ledger entries. Protocol validation and tool schema/finish checks remain stricter than the library's permissive partial tool JSON aggregation.

## Codex typed lifecycle design reuse

Pinned source: https://github.com/openai/codex/tree/398500106707f0a3217c7cf83edc2bf226cc342f

- `codex-rs/protocol/src/models.rs:975` MessagePhase explicitly distinguishes commentary, partial_answer and final_answer.
- `codex-rs/protocol/src/items.rs:158` AgentMessageItem preserves item ID and optional phase.
- `codex-rs/app-server-protocol/src/protocol/v2/item.rs:1348`, `:1426`, `:1448` started/completed/delta notifications bind thread, turn, item and real timestamps.
- `codex-rs/codex-api/src/sse/responses.rs:345` handles typed response item/text/reasoning channels separately; `:421` incomplete terminal handling; `:579` EOF before response.completed is an error.
- Tests in same SSE file `:760` retain partial_answer through start/delta/done with end_turn=false; `:925` completed item without completed response still errors. `codex-rs/core/src/stream_events_utils_tests.rs:493` commentary/partial do not close the nonterminal channel.
- Copy the lifecycle/fixture ideas into the existing adapter; no Rust code embedded. These functions depend on Rust serde enums, Tokio channels/stream timeout and the Responses API. Generated TS types do not implement those behaviors, and current provider speaks Chat Completions. Final phase is an assistant declaration, not proof of delivered artifacts or LingxiOS satisfied status. Do not import Codex's legacy unknown-phase compatibility fallback (`core/src/stream_events_utils.rs:543`) into v3; unknown prose must remain unpublished.
- Source license Apache-2.0, NOTICE Copyright 2025 OpenAI: https://github.com/openai/codex/blob/398500106707f0a3217c7cf83edc2bf226cc342f/LICENSE and https://github.com/openai/codex/blob/398500106707f0a3217c7cf83edc2bf226cc342f/NOTICE . No Codex source copied into product code in this research.

## Limits

Research and synthetic package probe only. No real provider, production API, private trace or secrets accessed. No production, merge, package release or schema changes. The initially proposed tiny MIT kernel adaptation is superseded by direct public API reuse after the successful probe. Final application adapter tests, strict v3 provider response fixtures, typecheck and integrated CI remain required.

## Local binding and schema gate

The public v3 producer uses the direct public APIs named above. Default provider
configuration is unchanged; a product explicitly opts into `purpose-json-v3`.
A native work item with `conversation.internal === true` selects the same
provider/client/capabilities with strict v2 before the first provider admission.
Its actual fingerprint and protocol are frozen in `runtime.binding`. A public
run without publication authorization does not take this route. Recovered runs
must match the entire binding and retain the original request and budget.

Ajv 8.17.1 (separate draft-07 and draft-2020-12 instances) and official
ajv-formats 3.0.1 validate exposed schemas and all arguments before dispatch.
Unknown keywords and references fail before generation. Coercion, defaults,
property deletion and remote schema loading are disabled. This syntax gate does
not replace each tool's business parser, authorization, approval or durable
side-effect ledger. See https://ajv.js.org/options.html.

No LangChain graph executor, tool node, checkpointer or tracer is installed into
our execution path. The browser projection has no LangChain imports. Native
fencing, sealed storage, outcome validation and outbox transactions remain the
only source of authority. Database schema stays 14; the readable public text
contract advances to 3.

## Optional native public answer binding

`publicAnswerTool: 'native-v1'` is an explicit v3/typed-message option for a
single-call native profile. `src/model/public-answer-tool.ts` constructs an
actual `tool(...)` from the already locked `@langchain/core@1.3.0`, then invokes
its public `convertToOpenAITool` adapter. The reused source is
`libs/langchain-core/src/tools/index.ts` (`tool`, JSON-schema structured-tool
construction) and `libs/langchain-core/src/utils/function_calling.ts`
(`convertToOpenAITool` → `convertToOpenAIFunction` → `toJsonSchema`) at the pinned
LangChain revision above. This adds no dependency and retains the upstream MIT
license in the distributed package. No upstream source was copied.

This is an output binding, not a second executor. Its upstream callable throws
if invoked; only the existing incremental `PublicPurposeParser`, authorized
seal transaction, `AnswerSegmentSet`, and outcome/delivery gates implement it.
The business catalog's schemas remain unchanged. The complete original native
batch must contain at most one call, including `public_answer`; a mixed public
and business batch is rejected before any seal or dispatch. Provider
`tool_choice` stays `auto`. No provider support for `required` is assumed.

The public tool carries the existing ordered v3 object (optional commentary).
Raw assistant content and reasoning never become public text or history. A
nonempty intermediate answer uses `outcome:null`; an ordinary completed answer
uses one output-tool generation with a terminal outcome. There is no obligatory
preface, router, evaluator, or lower task budget.

The host-only seal recovery record stores the exact native call and the same
memory dependencies as the text. Recovery appends that call and a fixed
`public_message_recorded` protocol acknowledgement once via the existing
request-scoped cursor. It does not append a duplicate assistant body, fabricate
a business receipt, or count the output binding as a business tool invocation.
The transaction checks recovery text/operation against the durable chunks.
For an allowed null terminal answer, no empty seal is created: the call/ack pair
is persisted in the current session before ordinary final validation. Losing
that session write cannot expose a half pair to the next request.

The option and history policy alter the provider fingerprint and frozen
runtime binding. Switching an explicitly internal conversation to v2 clears
this option; older v2/private behavior and v1 recovery records remain readable.
New tests live in `test/public-answer-tool-driver.test.ts` and
`test/public-answer-tool-worker.test.ts`. They qualify local synthetic behavior,
not provider support or production performance.
