# Model and publication timing v1

Public additions for LingxiOS #84 and LingxiLoop #653. The production-compatible
implementation targets `release/3.8`; consumers must pin a qualified formal
package after release. A source checkout is not a production dependency.

`ModelCallObservation.stageTimings` and the existing `model.request.finished`
event carry a safe, optional numeric projection. `version=1`, `clock=monotonic`,
`providerTime=unavailable`. All durations use process-local `performance.now()`.
The existing `latencyMs`, `firstContentMs`, cost, usage, status and retry meanings
are preserved. Missing fields mean unobserved, never zero. Existing history is
not backfilled. Generation/correction use the existing `operation`; retries keep
their real call IDs, reservation, token usage and billable failure records.

| Field | Boundary |
| --- | --- |
| totalMs | Existing invocation boundary, including started-event wait and local callbacks; excludes later usage settlement and final output seal |
| modelPermitWaitMs | Enter local ResourceQuota to obtaining its permit (or rejected/cancelled wait); excludes final admission transaction |
| httpToHeadersMs | HTTP fetch invocation to response headers |
| httpToFirstContentMs | HTTP invocation to first nonempty assistant content delta; no tool-only zero |
| httpToFirstCompleteToolCallMs | HTTP invocation to first ID/name and syntactically complete object arguments; this is framing, before semantic validation |
| observedStreamMs | HTTP invocation to local SSE consumption end, or interrupted consumption; includes headers, incremental parsing and callback backpressure |
| streamCompleted | True when local stream consumption ended normally, independent of final protocol validity |
| finalProtocolValidationMs | End of stream consumption to final protocol validation settlement; incremental parsing remains within observedStreamMs |
| outputCallbackTotalMs | Sum of decoded text and operation callback durations, including rejected callbacks |
| outputCallbackWaitMs | Union of callback intervals, including an unfinished callback up to cancellation settlement |
| outputCallbackCount | Number of callbacks started |
| httpRequestCount | HTTP attempts inside a direct driver invocation; the metered runtime disables internal retries, reserving each attempt separately |

HTTP fields describe the final internal attempt when using a driver directly.
Nonstreaming auxiliary responses measure observed body read and final validation;
their content/tool first-frame fields are absent. Custom drivers may omit HTTP
phases. Timing callbacks are local metadata and never enter HTTP payloads or
configuration fingerprints. `onTiming` is runtime-owned when metered.

The fields overlap. In particular observedStreamMs includes outputCallback waits
and cannot measure supplier-only inference. Never subtract overlapping durations
to invent exact provider time. Preserve old totals and label them observed model
invocation time. Parallel model/tool/publication spans cannot be added into run
wall time. Queue and execution boundaries, final result commit, delivery/outbox
acknowledgement, and unexplained run time remain distinct host-owned stages.
These model metrics do not claim to measure final delivery.

Public-output confirmation has a separate internal event:
`output.publication.finished`. Public exported type:
`PublicTextPublicationTiming`. It includes `callId` (the same attempt ID), fence,
requestVersion and monotonically increasing `revision`. The containing run event
provides runId. The model observation also provides workId, fence and
requestVersion. Cross-process correlation uses these identities; wall-clock
settlement events are not synchronized high-precision phase boundaries.

`publicationTotalMs` sums waits for existing authorized operation/delta/end/seal
persistence callbacks. `publicationWaitMs` is their interval union, including
serialized event-queue wait. `publicationCount` counts attempted writes;
`acknowledgedCount` counts completed acknowledgements. A failure exposes only
`stage=operation|delta|end|seal`, `code=persistence_rejected|cancelled`. An ACK means
the existing host callback resolved; this is not independently measured database
CPU time, IM receipt or user delivery. Multiple flushes are cumulative snapshots:
**replace by (runId, callId, fence, requestVersion), taking highest revision; never
sum revisions**. End can report before a later seal; retain the later snapshot.

Publication measurement retains ordering, bounded buffers, backpressure,
authorization, cancellation, failure propagation, source hashes and final sealing.
It does not introduce an output queue. At most one diagnostic snapshot is emitted
per changed end/seal write count. Diagnostics are best effort and cannot replace a
publication error or change an output ACK. Missing diagnostics are unknown.
Their own persistence overhead is excluded from publication wait and must not be
mistaken for a faster output path. Neither telemetry channel contains prompt,
response, tool arguments, credentials or arbitrary exception messages.

Loop integration must preserve its shared LLM ledger, tenant/permission checks,
new/old event compatibility and exact formal-package provenance. Display separate
model/correction, tool, publication and remaining run spans. A product-schema
change must use the owning migration workflow, never runtime DDL. Supplier and
same-task p50/p95/overhead comparison remain release acceptance evidence; synthetic
clock fixtures establish attribution and invariants, not provider performance.
