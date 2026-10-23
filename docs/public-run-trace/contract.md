# Public execution trace v1 (3.8.0 release candidate)

`readRunTrace(identity, operation?) -> Promise<RunTraceSnapshot | null>` and
`streamRun(identity, { trace: true })` opt-in event `{ type: 'trace', runId: string, trace: RunTraceSnapshot|null }` share
current authorization. Product consumers use these public contracts only.

Snapshot: `version: 1`, durable root event `seq`, opaque `revision`, `runId`, current `requestVersion/fence`, `rootSpanId`, `queuedAt: number|null`,
`origin: number|null`, `spans: RunTraceSpan[]`, `truncated: boolean`.
All times are UTC epoch milliseconds; origin is the root's durable execution
start, **not** creation/subscriber/observer time. `queuedAt` is separate.
The snapshot is a full replacement; a failed read is unavailable, never proof
that a prior partial set is a complete current total. A null stream snapshot explicitly clears availability and aggregate totals. Optional SSE trace reads have one independent in-flight task and a 500 ms database deadline; they cannot block answer events or close the answer stream on diagnostic failure. Root authorization still gates each iteration. Revisions include the current root identity header, even when its event seq has not changed. Each span has a stable
`spanId`, explicit nullable `parentSpanId`, `runId`, `requestVersion: number|null`,
`fence: number|null`, `attemptId: string|null`, `kind: agent|llm|tool`,
`state: running|waiting|complete|cancelled|failed|unknown`,
`startedAt/completedAt: number|null`, `timingBasis`, durable native event `seq: number|null`, and `revision: string`.
`revision` is an opaque equality token, not a global ordering or clock. Native
seq is monotonic per run, but late model settlements and child updates can change
revision without changing the root seq; do not discard equal-seq snapshots.

Agent spans represent the run lifecycle, spanning waits/retries; their
requestVersion/fence/attemptId are null rather than a mutable execution identity.
The current root requestVersion/fence are separate snapshot fields. LLM/tool
spans have immutable execution identity from the recorded start. Their parent
is the owning agent span; tool execution is not falsely nested inside a completed
LLM invocation. LLM `attemptId` equals its explicit callId (the identity used by
native public text). Tool `attemptId` is its recorded originating model attempt.
No consumer parses opaque IDs to establish lineage.

LLM fields: `callId`, `model: string|null`, `usageAvailable: boolean`,
`inputTokens/outputTokens: number|null`, `costMicros: number|null`.
The model interval is `model-invocation`: admission/publication/provider/control-plane
settlement, not provider network-only latency. Start is committed before invoking
the provider; completion is the control-plane observed settlement. Both timestamps use the
control-plane clock, never worker or observer arrival clocks; a backwards-clock
interval has an unknown end rather than a negative/fabricated duration. Timeout/cancellation
does not claim remote execution or billing was stopped. Usage is populated only
when the provider supplies measured usage; missing pricing is never displayed as
free. Cost is optional and remains null for an absent/zero default price schedule.
Tool fields: `toolCallId`, `name: string|null`; timing is `host-action` and excludes
raw arguments/results. In-flight tools whose run terminates without a receipt
remain `unknown` with null completedAt, not a fabricated cancelled/completed time. Replayed tool receipts with the same explicit execution identity retain the first interval; they do not extend execution time. Backwards clock intervals have a null end.

Authorized descendant agent spans additionally carry `childRunId`. Discovery
uses the native parent relation, same tenant/principal/thread/conversation,
then reauthorizes every child against its current policy and frozen audience.
Revoked/inaccessible subtrees disappear from a replacement snapshot. A child's
opaque session is discovered by the runtime; callers cannot nominate it. Traversal
is bounded (32 runs, depth 8, 512 spans), reports truncation/visibility gaps, and does not leak the
IDs of excluded children. Native memory maintenance runs are excluded. Root access is rechecked on every snapshot/live replay.

No prompts, model.request payloads, hidden reasoning, raw tool I/O, credentials,
provider errors or untrusted labels are copied. New timing metadata uses existing
fenced event and model-observation storage; there is no new native/product DDL.
Old history without recorded execution fields keeps nulls; no backfill guesses.
Existing events remain compatible. The release owner assigned runtime3.8.0/runTrace1; no package is published by
this feature branch. The stream opt-in does not enable public-text production.

## Failure model written before implementation

1. Unauthorized root/child, revoked audience or wrong tenant/session/thread leaks
   a span: reject root or omit the inaccessible subtree on live and replay.
2. Reconnect/replay invents timing, duplicates spans, or old fence overwrites the
   successor: persist before invocation, use immutable keys, fence writes, replace
   snapshots and compare opaque revisions.
3. Provider/tool cancellation invents completion/usage: preserve actual local
   settlement and unknown outcome/missing usage, including late budget settlement.
4. Internal prompt/arguments/results enter trace: explicit field allowlist only.
5. Unbounded child/event scans stall foreground conversation: enforce depth/run/
   span limits and report truncated coverage; no claim of complete aggregate.
6. Old records/queued/waiting runs appear to have zero duration/cost: preserve null
   start/end/usage and identify queue creation separately.

Focused persistence/Worker-boundary and SSE tests exercise these failures without
external providers, production data, or browser/device acceptance expansion.

3.8.1 corrects terminal state projection: `TraceState` additionally preserves `partial` and `blocked` from the durable work record. These known goal outcomes are neither `complete` nor `unknown`. The actual `finished_at` remains the execution end; waiting/active runs remain unended. This additive state correction leaves snapshot version 1 and native schema 14 unchanged.

Terminal SSE follow-up (3.8.2): partial/blocked persisted trace states must survive
the realtime phase/fence/request-version gate. Fresh SSE and a reconnect cursor
past all user events must both finish with the exact authorized readRunTrace
snapshot, including revision and actual start/end. They must not emit a null
trace because a known terminal outcome was classified as unknown. Wrong-fence,
stale-version and unavailable reads remain rejected; no budget or SQL changes.

## Native tool execution coverage

Python spans use `kind: tool`, the fixed name `ipython`, optional `stepId`, the
original `toolCallId`, and `timingBasis: python-execution`. Their clock boundaries
are control-plane observations of the Python invocation lifecycle, including
its output checkpoint, not Python CPU time. Only explicit Python identities are
admitted; the historical generic `ipython.*` wrapper around direct tools does
not create another span. Known timeout, failure, approval wait and acknowledged
kernel cancellation retain their real observed state and boundary. A missing
terminal event remains unknown after its attempt stops.

Native host dispatch is now observed independently of Worker presentation hooks.
After authorization and cached-receipt checks, the control plane persists a
reserved `runtime.action_trace` marker in the existing step store before invoking
the action. Its interval ends after receipt persistence. This includes internal
`task.inspect` and `task.check_resource` calls. These are host dispatch intervals,
not claims about remote side-effect completion, resource correctness or browser
execution. Nested private operations inside a tool and transport retries are not
invented as separate stages without their own measurements.

Native spans keep the existing `host-action` timing basis, exact host
`toolCallId` and optional cell `stepId`. A Python parent is supplied only for an
observed cell with the same run, request and fence. Otherwise the owning agent is
the parent. The originating model `attemptId` is nullable when no matching hook
provides it. Native-only steps have no event `seq`; their opaque revision still
changes, so an equal root sequence must not suppress a replacement snapshot.

Each actual dispatch has a distinct native trace identity. A cached receipt
creates no new interval, including after recovery under a new fence. Exact
action identity and request version suppress duplicate Worker hook spans; a
label alone never merges calls. Tool spans never copy LLM usage or cost. A
failed final diagnostic write leaves an unknown end without changing an already
persisted action receipt. A failed pre-dispatch write prevents dispatch; a newly
reserved uncertain action records known non-dispatch rather than inventing an
unknown effect. Safe concurrent retries retain their existing ledger rules.

These reserved diagnostic steps are absent from both ordinary and optimized
context/recovery snapshots, progress facts and semantic-review observations.
Their SQL projection selects only safe names, identities, timestamps and states.
The existing read authorization, traversal bounds and truncation behavior remain
in force. No schema, snapshot version or release identifier changes are made by
this feature branch. Older history receives no guessed starts, ends or parents.
