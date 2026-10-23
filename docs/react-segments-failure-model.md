# Ordered public answer segments

The existing purpose-v2 writer archives tool-turn answers but accepts only the last
turn's answer. Repeated attempts can also be mistaken for replacement. The new
opt-in purpose-v3 contract makes continuation and replacement explicit while
leaving v1/v2 parsing and persisted history readable.

Failure cases to test before implementation:

- A substantive A, native tool, substantive B, and terminal declaration must commit
  A+B in source order. Commentary and hidden provider reasoning must never join it.
- Metadata must precede answer bytes. Unknown/duplicate operation fields, invalid
  supersedes, cross-run/request references, incomplete JSON or finish, malformed
  calls/arguments, and cancellation must not seal or dispatch a damaged turn.
- A null last answer is legal only when the runtime already has a nonempty valid
  sealed source collection; the complete accumulated body still passes every
  citation, policy, resource and delivery-obligation check.
- Append concatenates exact segment bytes, followed by one outer trim. No implicit
  separators or similarity-based deduplication. Each segment hash binds raw text;
  the final hash binds the assembled trimmed body.
- Replacement names current same-request sources. A proposed replacement cannot
  erase visible old sources; only the verified atomic final result activates the
  replacement collection. Failed validation, cancellation, or persistence failure
  retains the previous sealed collection.
- Operation, delta, end and seal events are authorized, fenced and ordered. A seal
  binds the complete durable delta sequence and may not be written after an error.
- Recovery can read sealed older-fence sources of the same run/request, but can
  never append using an older fence. Incomplete segments stay unaccepted. Replay is
  identity-based and idempotent, never based on textual similarity.
- Final source order, per-source hashes, full body hash, outcome, result event and
  delivery outbox commit in the existing transaction. Tampering or missing sources
  rejects the complete transaction. No schema migration is planned.
- Runtime binding and provider fingerprint explicitly include the new protocol.
  Upgrades must drain or resume old runs on their pinned version, never reset their
  budget or relabel old checkpoints. Existing authorization, approvals, unknown
  effect reconciliation and bounded correction budgets remain enforced.

This is synthetic design evidence, not a diagnosis of an unobserved provider
failure. The previous visualization protocol failure remains unclassified until a
fresh authorized structural observation supplies its actual failure code.

The v3 wire JSON parser permits at most 256,000 framing/content characters;
the existing public publisher still bounds observed UTF-8 text at 200,000 bytes
per part, and the source collection at 200,000 UTF-16 units. These are distinct
limits, not truncation targets. A suspended/incomplete public part cannot be
sealed or become accepted provenance. Existing final envelope/policy limits
still apply to the complete assembled body.

Private compatibility is selected only from native `conversation.internal ===
true` before provider admission, using the same configured provider with strict
v2. Actual selected fingerprint/protocol and selection policy are bound. Public
authorization denial never triggers this compatibility route.
