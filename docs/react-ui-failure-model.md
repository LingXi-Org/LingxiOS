# Read-only public answer projection

The browser consumes authorized native public events and committed messages. It
does not run LangChain, decide tool authority, create replacement identities, or
accept model-provided source collections. Hashes are verified by the server's
result transaction; this synchronous helper checks the identities, ordering,
ranges and any already archived seal metadata before displaying that result.

Red cases to establish before implementation:

- An operation precedes every v3 delta; changed identity, missing chunks, duplicate
  operation/end/seal, deltas after end, and sealing a failed part are rejected.
- Distinct append identities with identical text remain distinct across tool turns
  and attempts. Concatenation is exact, with one outer trim and UTF-16 ranges.
- Pending, failed or cancelled replacement never removes old text or becomes a
  second normal answer. Only a trusted committed source collection activates it.
- Final sources atomically reorder/select immutable revisions; late same-part
  events and SSE replay cannot reintroduce the superseded answer.
- Message-first recovery renders the canonical final body from source ranges
  without requiring the complete event history. Later replay must agree with the
  source identities, raw segment hashes and ranges, or fail closed.
- Cross-run/request/fence identities, incomplete final coverage, overlapping
  ranges and mismatched known seals cannot be accepted. A malformed input must not
  mutate the prior projection.
- A reset or restored checkpoint retains sealed same-request sources; a newer
  request does not borrow prior-request answer segments. Legacy v1/v2 commentary,
  answer acceptance and replay behavior remain on their existing path.

Only `src/ui/index.ts` and its focused synthetic tests implement this boundary.
No production access, real provider request or database write is needed here.

## Product interface

`publicAnswerSegments(view: RunView): PublicAnswerSegmentView[]` returns the current
request's active segments in canonical source order, followed by pending or
replaced archive entries. It does not duplicate legacy v1/v2 parts. Product code
excludes `pending-replacement` and `replaced` from the answer body, and uses
`partId` for archive keys because revisions retain their logical `segmentId`.
Each item includes its explicit operation, source IDs, canonical text and UTF-16
ranges. Archives use range 0/0. A part ended without its durable seal is incomplete.

`RunView.publicTextCommit` is an internal committed-source cache and must be
excluded alongside publicTextParts from generic product transport projections.
When all sealed sources are present, response.committed activates the complete
collection on that event. Otherwise old text remains until the trusted committed
message arrives. Message-first recovery derives the answer directly from the
committed body and ranges; no historical event download is required to render it.

## Focused verification

The first nine cases ran before implementation and failed 9/9. The final focused
run passed 22/22 with zero skips: 14 new projection cases and the eight existing
public-text archive/acceptance cases. A separate purpose suite passed 7/8; its one
remaining assertion expected reader capability 2 while this parallel candidate
now advertises 3. That version assertion belongs to the runtime integration owner.

Compilation emitted the focused tests into a separate temporary directory; it did
not replace the shared dist directory or installed package. No UI-file TypeScript
errors remained. At this handoff the shared candidate still had two unrelated
optional executionSteps errors in react-segments-recovery.test.ts, so this record
does not claim that the whole candidate typecheck or final package gate passed.
