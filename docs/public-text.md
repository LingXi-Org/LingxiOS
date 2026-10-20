# Durable public text

Public commentary is an append-only archive separate from the verified final answer. It remains available after native tools, provider retries, cancellation, a lost worker, and later request revisions. This feature uses the existing JSONB event log and durable attempt records; it needs no migration.

Products enable publication through trusted `realtime.allowPublicText(work, requestVersion, context)`. The context provides the current bounded transaction's `database`, `signal`, and absolute `deadlineMs`. Each new event rechecks the current lease, request version, cancellation, native IM speak/audience authorization, and the product callback in the same transaction as its append. That operation has a three-second deadline. Identical acknowledged-or-uncertain event replays are idempotent; a conflicting replay is rejected.

The feature is disabled for existing callers. A product enabling it must supply its streaming content policy and should set `allowDraft: () => false`. Enabled user-text publication automatically suppresses that turn's ephemeral preview, but the explicit setting also disables older candidate-JSON previews. Only a driver-declared `user-text` channel can publish. Provider reasoning fields, tool arguments, candidate-JSON drivers, and structured/compaction output do not enter this archive.

## Streaming content policy

`RuntimePolicy.publicTextSafety(input, context)` is a synchronous, trusted, pure policy hook. `PublicTextSafetyInput` and `PublicTextSafetyDecision` are exported from the package root. `DefaultRuntimePolicy` trusts structurally separate user text; deployments override it for their own public syntax rules.

```ts
interface PublicTextSafetyInput {
  text: string
  isFinal: boolean
  approvedThrough: number
}
interface PublicTextSafetyDecision {
  safeThrough: number
  reject?: 'unsafe_content' | 'unsupported_content'
}
```

Offsets count UTF-16 code units. A decision approves only a monotonic prefix, within the received text and outside a surrogate pair. The input is frozen. A policy cannot replace, withdraw, or rewrite already-published text. Invalid, asynchronous, or throwing policies fail closed without retaining their exception text. Only the newly approved prefix reaches the durable writer; incomplete syntax stays private. A product can therefore hold a partial marker across deltas, distinguish quoted code, and reject an opening reasoning marker before any of its body is published. Final-answer citation and completion checks remain separate.

The first input is assessed immediately. Later input is assessed and written at coalescing boundaries of 50 ms or 4 KiB. The official model driver awaits publication acknowledgements, applying backpressure while a write is outstanding. Event text is split at Unicode code-point boundaries into at most 4 KiB chunks.

Each provider attempt retains at most 200,000 UTF-8 input bytes while active, with at most 64 KiB of unapproved suffix. An uncertain suffix may be held for one second. Reaching those public-commentary limits pauses publication for that attempt, discards the held copy, and marks an existing part `interrupted`. It does **not** cancel the provider or impose a new final-answer length/deadline limit. At EOF the hook examines the existing complete `turn.text`, without accumulating a second full response after suspension. A safe final answer can still be delivered normally. The commentary remains incomplete.

EOF safety also applies before a native tool starts. A user-text driver must return its accumulated text in `turn.text`, including pre-tool content; it may not return an empty or different text after emitting nonempty deltas. Explicit rejection or an unapproved EOF enters the existing bounded protocol-correction path; it is not a transient provider retry. An actual storage failure is nonretryable. Received usage remains available for settlement when the driver has received it. Existing caller-abort accounting can conservatively settle a reservation before a late usage observation; this change does not alter that shared cancellation contract.

A final return value without `onTextDelta` does not create an extra commentary part. EOF checks the entire return value for safety, while publication only archives actual received deltas. `completed` is recorded only after the existing final validation accepts the corresponding candidate. Withheld candidates remain incomplete; a successfully closed pre-tool segment has reason `tool` and does not imply task success.

## Events and public projection

`public.text.delta` and `public.text.ended` carry version 1, request version, fence, provider `attemptId`, stable `partId`, and `partIndex`. Deltas add an append ordinal `chunkIndex` and text. Ends record the committed `chunkCount` and a closed reason: `completed`, `tool`, `failed`, `cancelled`, `superseded`, or `interrupted`. No exception detail is part of this payload.

The `/ui` export provides `PublicTextPart`, `PublicTextEndReason`, `PublicTextAttempt`, and `consumePublicTextAttempts`. `RunView.publicTextParts` is optional for compatibility and initialized by `createRunView`. Parts are ordered by `firstSeq` and include `runId`, the complete identity above, text, `firstSeq`, `lastSeq`, `chunkCount`, `endedSeq`, status, reason, and `acceptedResultId`. `endedSeq` is non-null only for an explicit end event. Later lifecycle metadata may correct an inferred end, but never overrides an explicit end.

Status is `running`, `complete`, or `incomplete`. A complete segment is still commentary, not an `AssistantMessage`, proof of a successful tool, or a successful final answer. Preview resets do not erase these parts. Consumers must render the text as data, never as raw HTML.

`acceptedResultId` starts as `null`. A finalized message can carry the optional `publicTextPartId` of its exact published source. The final-result transaction validates that this part belongs to the run and accepted request version and has a durable binding to the accepted candidate body, then persists the message and `response.committed` event with the source ID and result ID together. Generic worker event submission rejects the reserved `response.committed` kind; only the result transaction creates it. A retained candidate saves its source ID with its durable execution step, so that an older provider attempt or fence can remain identifiable without comparing text. A transaction rollback, cancellation, revocation, or stale revision does not associate the part. A lost COMMIT acknowledgement can be recovered through the committed public read and an identical result retry.

The UI projection associates the explicit source after a committed message or `response.committed` event, including current-state-first and older-fence replay. The original part and its termination reason remain unchanged. `public.text.ended` with reason `completed` alone is **not** an accepted-result association. A main conversation can omit parts whose `acceptedResultId` is non-null to avoid showing a streamed final answer twice, while an activity-history view retains them. Pre-tool commentary, other provider attempts, and unaccepted candidates remain visible. Do not infer this relationship by string equality or by choosing the latest part.

`readRunState` provides terminal metadata for the current fence. `readEvents` retains its existing 100-event page contract and adds `publicTextAttempts`, querying only the distinct fences in that page. It does not scan or truncate all attempt history. Consumers merge this metadata before replaying a page:

```ts
view = consumePublicTextAttempts(view, page.publicTextAttempts ?? [])
for (const event of page.events) view = consumeRunEvent(view, event)
```

`streamRun` supplies the same metadata before each relevant page. State-first replay still archives older fences and request versions. If a worker cannot run a `finally` block, the existing durable attempt state closes unfinished parts after cancellation or lease recovery. Explicitly ended provider attempts within the same fence retain their own reasons.

New native `tool.started` / `tool.completed` events record the triggering `requestVersion`, `fence`, and provider `attemptId`. They do not change business receipt identity or replay a tool. Products should discover old runs through their own durable, authorized run anchors and then use the public per-run APIs; a recent-runs UI limit is not a history-recovery contract.

## Validation boundaries

The upstream tests use synthetic providers and isolated PGlite databases. The process-recovery test runs real HTTP workers in separate Node processes, kills only its own test worker after a persisted prefix, then starts a fresh worker against the same isolated database. It is a real process/HTTP recovery test, **not** a network PostgreSQL crash or production test.

The [evidence manifest](evidence/public-text/manifest.json) records the exact tested source commits, Node version, commands, log hashes, the baseline failures, and later fixes. Product-side network PostgreSQL, authorization, IM discovery, and rendering acceptance belong to the consumer integration. No real provider or production result is claimed here. The package version remains unchanged in this independent feature branch; release versioning and integration with other runtime changes are coordinated separately.
