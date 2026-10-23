# Protocol recovery failure model (LingxiLoop #332)

The production evidence establishes `protocol` + normal `stop` followed by a
`model_unavailable` terminal. It does not expose the malformed response field.
All provider bodies below are synthetic; no production task is replayed.

Before implementation, the owning failure cases are:

0. Mixed LF/CRLF blank lines are accepted by the SSE delimiter pattern but
   consumed with a guessed length, dropping a character from the next event.
   All four accepted combinations and network splits must preserve every frame.
   This is a local deterministic defect, not a proven original production cause.
1. A complete purpose JSON object with empty answer and no native tool call can
   emit commentary, then fail. Current feedback calls every model protocol error
   a tool protocol error, without identifying the missing substantive answer.
   A bounded corrective turn must identify that exact contract failure, preserve
   the original request and require either a real authorized tool call or a real
   answer. It cannot accept commentary as a result or manufacture a tool action.
2. Invalid framing and incomplete framing need fixed, allowlisted classifications
   so correction and public diagnostics do not depend on raw provider text.
   Duplicate/reordered keys, extra text, invalid escapes and oversized framing
   must remain rejected. No fallback to plain text or hidden reasoning is valid.
3. Invalid tool identity and genuinely empty legacy output remain distinct from
   public-purpose errors. Correction cannot enable Python when it is disabled,
   introduce tools, or replay previously completed/uncertain effects.
4. Measured usage, normal finish reason and original cancellation must survive
   typed protocol errors. No fabricated HTTP failure, quota or provider outage.
5. Persistent malformed responses remain bounded by the existing shared protocol
   correction cap and root model budget; this issue does not change those values.
6. A terminal protocol failure must persist an execution/protocol classification,
   while actual provider failures retain their provider classification. Public
   events and terminal feedback must not contain raw response/error bodies,
   prompts, correlation identifiers, credentials or hidden reasoning.
7. End-to-end worker evidence must exercise the real HTTP driver, durable model
   reservations/settlements, normal tool execution and final result commit. A
   successful corrected answer alone does not prove the original private run's
   exact malformed field; document that boundary explicitly.

Budget policy and the partial-result UX belong to the parallel #331 work. Any
common runtime edits must be reconciled before a single formal upstream release.
