# Request history ownership

The same session can contain several independently terminal work items. Its
durable native call/output pairs remain useful evidence, but sending those pairs
as live assistant/tool messages on a new work item leaves the prior task open in
the model's conversational representation. In the synthetic graph → arithmetic
case the old activation was paired and belonged to the old work; it was not
reexecuted. The arithmetic request, version and trigger were correct. Its new
save created a new obligation, which correctly rejected the later bare `43`.

A second, independently reproducible defect is more direct: restore previously
scanned old unpaired calls before checking request ownership and could recover
or execute them under a new work identity. Unknown effects must remain unknown.

Required boundaries:

- Failed and successful graph history → a new arithmetic request: old request,
  calls, receipts and answers remain available as historical observations, with
  their original work/version; they are not live assistant/tool turns.
- Identical request text in two different works is still a new request.
- An explicit request to continue the old graph can consult the archived facts;
  it never automatically replays old effects under a new lease.
- Same-work restart keeps native call/output protocol and ledger recovery.
- Archive metadata survives session serialization and repeated work changes;
  it never fabricates a result or changes original business arguments/receipts.
- Memory authorization is applied before projection, including revoked results.
- Existing approval/input continuation and compaction semantics stay bounded.

`historySource` records the work/version where a new runtime record was created.
An old untagged record is unknown unless a matching current-work checkpoint or
ledger recovery proves ownership. A receipt that only proves work/cell retains
an unknown version. The shared session's raw request boundary is kept separate
from its work-specific effective request; neither the latest request nor a
reused provider call ID is enough to assign every old record's origin.

The read-derived history boundary also participates in lost-save-response
reconciliation. Its expected value must come from the request this save wrote,
not from a missing or stale client read. A different raw persisted boundary must
still reject the retry even when the work-specific effective request matches;
revision, lease and all other saved fields remain strict.

Recovery and input-wait closure use these same owners. Foreign or unknown
effects are never labelled `not_started` merely to close a protocol pair.
Compaction estimates the authorized projected input, including archive framing,
while retaining the existing budgets and preserving active native pairs.

All regressions use a fake model/host or local in-memory data. No provider or
production request is needed to establish these structural invariants. These
tests establish input/recovery correctness, not a claim that a live model will
now choose the right action; the full same-session qualification remains due.
