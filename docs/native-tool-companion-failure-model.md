# Native tool companion text: failure model

Written before implementation. All examples and test inputs are synthetic.

Some explicitly configured providers cannot combine JSON response mode with native tools. A complete native `tool_calls` response can then contain ordinary, untyped prose in `content`. Rejecting the first prose character aborts consumption before the valid tool call and its measured usage arrive.

Required boundaries:

- Compatibility applies only to an explicit `jsonObjectWithTools: false` profile, a purpose protocol, exposed tools, and a complete successful native tool turn. It is not a fallback for final answers.
- Untyped tool prose is never streamed, saved as an assistant answer, used as completion evidence, or copied into diagnostic text. A fixed classification and measured usage preserve the actual call without inventing a public purpose.
- Structured purpose framing remains strict once it starts. Corrupt, truncated, reordered, duplicated or trailing JSON cannot use the compatibility path, including after a public prefix has streamed. JSON/markup wrappers are not ordinary prose.
- Unknown, missing, duplicate or changed identities; invalid call indexes/types; partial/invalid arguments; inconsistent terminal reasons; and multiple calls when parallel calls are disabled cannot be accepted by discarding part of the batch.
- Exact tool argument schema, authorization, approval, cancellation, idempotency and durable receipts still belong to the existing runtime/executor. This change cannot grant authority or repeat an uncertain effect.
- Output bounds, measured usage, global budgets and cancellation remain enforced. No retry budget is added. Tool-only compatibility does not assert task completion.
- A behavioral policy change must alter the applicable model fingerprint; legacy structured/default profiles retain their identity. Old checkpoints cannot silently resume under the new policy.

Verification starts with driver wire regressions and includes a formal Worker flow that executes a synthetic authorized tool once, then commits a strict final answer. Existing protocol, cancellation, budget and worker tests remain required. No private production trace, conversation, provider key or reasoning stream is used.
