# Runtime 3.8.6 candidate

Large request evidence previously switched to an all-or-nothing catalogue. One
long excerpt hid already-read short excerpts, requiring a separate model/tool
round trip for each. The bounded prompt now retains complete short excerpts with
their exact markers while keeping large excerpts on demand. It does not invent
summaries or rewrite durable evidence.

Evidence paging distinguishes the remaining pages of the stored excerpt from
incompleteness of the original source. EOF returns `hasMore: false` and
`nextOffset: null`; `sourceTruncated` preserves the source-coverage limitation.
Oversized structured read results retain their range schema and an accurate
model-visible continuation. Their canonical receipt still hashes the complete
recorded value, including after recovery. Unknown, pending and failed results do
not acquire a successful partial-read view.

After reauthorizing a durable request, the control plane can tell the product
that nonempty first-version evidence is already frozen. This avoids repeating
retrieval that the worker would discard. The hint is never accepted from work or
tool metadata. New requests, revisions and empty snapshots do not receive it;
current permission checks always run.

Focused source tests were run red before implementation. The 33 evidence/tool
checks and the new control-plane frozen-evidence regression pass. Typecheck
passes. The same scripted AgentRuntime scenario against 3.8.5 and this candidate
uses 8 versus 3 model calls and 5 versus 0 extra snippet reads. Both retain one
artifact save, one read-back, complete final delivery and zero auxiliary judges.
Source-backed public answer text is durably appended before the save. With an
explicit local 25 ms delay per scripted provider call, measured first durable
answer was 273 ms versus 61 ms and total execution 360 ms versus 140 ms. These
are synthetic local measurements, not real-provider or production guarantees.

Only the package/root lock versions and `releaseVersions.runtime` advance to
3.8.6. Native schema 14, control-plane protocol 11, public-text reader 2 and
run-trace 1 stay unchanged. No DDL or migration is added. Existing bindings
include the runtime version and continue rejecting changed behavior. Drain or
resume unfinished work on its original pinned deployment; never reset its
budget or disguise this release as 3.8.5.

Exact CI, formal registry publication and product integration remain separate
gates. This document does not claim any of those operations occurred.
