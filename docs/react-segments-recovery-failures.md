# ReAct segments: independent recovery and safety failure model

Written before recovery tests. Baseline runtime source:
`387ec2867267734d3b357202192c94bfe6ffc729` (formal 3.8.6).
This file contains no production evidence, credentials or private receipts.

- A segment is not sealed merely because some answer bytes were streamed. Full
  protocol, tool identity and safety validation must succeed before sealing.
- A final null answer requires a valid nonempty active sealed set of the same
  run/request; commentary, old requests, unsealed drafts and an empty set cannot
  satisfy it. The final body is built from ordered validated segment identities.
- Segment content/hash/count and append/replace operation must agree. Duplicate
  matching events are idempotent; conflicting identities, hashes or bytes reject.
- The official LangGraph identity reducer preserves a logical `segmentId` slot;
  immutable `partId` identifies each revision. Replacing one or more active parts
  updates the first logical slot and explicitly removes the others. Upstream
  append/update/remove/order tests must remain applicable before safety adapters.
- Final source ranges are contiguous UTF-16 half-open offsets over the exact
  concatenated, once outer-trimmed body; raw revision hashes remain unchanged.
  Reject reordered sources, gaps/overlaps, wrong final length, swapped revisions,
  duplicate identities and forged hashes. Whitespace-only sources may have an
  empty range; non-BMP text is counted in UTF-16 units, never code points.
- Replacing active segments is atomic at commitment. Until success the old body
  remains authoritative. Failed, cancelled or stale replacement changes nothing.
- A replacement cannot target another run/request, an inactive segment, or a
  segment whose expected revision/hash changed. Text equality grants no authority.
- A new lease may recover old-fence *sealed* segments after current authorization
  and binding checks. It must not accept old-fence new writes or promote an old
  incomplete draft. Replaying a seal cannot create a second final message.
- Recovery must reconcile an unknown side effect under its existing idempotency
  identity, never dispatch the operation again to obtain a convenient receipt.
- Cancellation at admission, after A, before/between tools, during replacement,
  before seal and before final commit prevents subsequent dispatch/success. It
  does not rewrite the historical fact that A was already delivered.
- Citation, artifact ownership, resource and visualization obligations validate
  the entire assembled body. Putting an invalid reference in an earlier segment
  cannot evade checks on the last answer or on `answer: null`.
- Segment recovery cannot reset the durable budget, silently switch a frozen
  harness, invent a receipt, or interpret private reasoning as public content.

Use public control-plane APIs and a scripted local provider. Real PostgreSQL
tests cover the transaction/fence boundary where an in-memory test cannot.
Keep execution/acceptance results explicit. No real-provider request, production
read or deployment is part of these tests.
