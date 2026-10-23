# Content-review deferral input failure model

The primary content review needs evidence, attachment previews, execution receipts,
resource checks and the authorized conversational context to evaluate fulfillment.
The deferral decision has a narrower purpose: decide whether a finding is solely
about an action the human excluded, cancelled or reserved for a later stage. The
candidate combines both decisions in one independent content-review call, with
separately validated finding IDs and exact human quotes for any removal.

Failure cases to cover before changing implementation:

- Repeating source/context/tool/memory payloads in the follow-up increases paid
  input and time after the answer is generated. Untrusted sources cannot establish
  human authority to exclude or defer a requirement.
- Removing or truncating original human requirements or ordered revisions can
  manufacture a deferral, miss a later confirmation, or grant an agent revision
  authority over the human. Keep complete text, IDs and author kinds in order.
- Omitting the candidate body or proposed findings can hide current omissions or
  incorrectly dismiss a finding mixing current work and future work.
- Native resource gaps, unsettled actions and explicit human blockers must remain
  outside this fallible deferral decision. Preserve their existing treatment.
- A larger finding set can exceed context after the primary review fits. Keep
  bounded input admission; never truncate requirements or fail open.
- Cancellation, malformed findings, provider errors and budget rejection must
  retain current gaps and must not claim completion. Keep existing usage/identity
  accounting for every actual attempt and exact input hashes for repairs.
- Do not mutate the request, evidence, observations, or primary review result.
- Absent, malformed, invented, duplicate, agent-only or blocked finding IDs in
  the combined decision retain valid findings, without a fallback model call.
- A declared limitation without an applicable human exclusion remains a gap.
- Both decisions use one attempt and one usage record; never bill usage twice.

Validation uses synthetic content only. It proves a code-level inefficiency and
its correction, not the purpose or duration of a private production request.
