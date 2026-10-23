# Nullable native tool deltas

Failure model, before the fix: a complete native call is split across SSE chunks.
The initial chunk supplies its index, ID, type and function name; later chunks
use JSON null for optional metadata and supply the remaining argument string.
The old accumulator treats each null as malformed, even though the assembled
identity and arguments are valid. Both the strict v3 turn gate and the unpublished
tool-companion gate therefore reject this input with `tool_identity_invalid`.

The upstream wire contract is the OpenAPI-generated
[OpenAI Python `ChoiceDeltaToolCall`](https://github.com/openai/openai-python/blob/56a55f243960e05e6268bb48ba6bf45299b8f90b/src/openai/types/chat/chat_completion_chunk.py):
ID, type, function, function name and function arguments are nullable optional
delta fields; index is a required integer. The minimal adapter change treats
null exactly like an omitted optional field, preserving the existing accumulated
value. This reuses that wire convention, not a new tool execution runtime.
The corresponding [official JavaScript accumulator](https://github.com/openai/openai-node/blob/4c11b87c3e5e4fcddeeffc85b55502b2296f49fd/src/lib/ChatCompletionStream.ts#L1946-L1997)
also guards optional metadata and appends only non-null argument fragments. The
adapter retains its stricter rejection of invalid non-null types and conflicting
identities; no SDK execution loop or permissive JSON parser is imported. This is
a small semantic adaptation, not a claim to embed that SDK. Existing official
LangChain/LangGraph reuse remains unchanged.

Required regressions: each nullable field, combined fragmented fields, unchanged
usage, no companion text publication, strict final answers, and actual Worker
authorization/exactly-once execution. Null index, non-null invalid types,
conflicting identity, invalid final JSON, incomplete calls, duplicate identities,
post-finish data, cancellation and malformed purpose JSON remain failures.
Final calls still pass the complete batch/schema gate before tool dispatch, and
v3 final answers still require validated sealed sources and native commit.

This demonstrates an independently reproducible wire compatibility defect. An
external observation that did not record null versus absent fields cannot prove
that its failure was caused by this defect. Do not relabel such historical
evidence or claim a real-provider qualification from synthetic tests.

The provider configuration fingerprint includes the new nullable-delta policy.
Existing frozen runs must retain their old strategy or be drained; a changed
provider protocol policy cannot silently resume under the old fingerprint.
