# Protocol recovery failure model

All provider bodies below are synthetic. This document describes generic driver
and runtime contract failures; it contains no external production evidence.

Before implementation, the owning failure cases are:

0. Mixed LF/CRLF blank lines are accepted by the SSE delimiter pattern but
   consumed with a guessed length, dropping a character from the next event.
   All four accepted combinations and network splits must preserve every frame.
   This is a local deterministic defect.
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
   successful corrected answer only proves the exercised synthetic scenario.
8. Experience measurements must use actual public answer callbacks after durable
   append, exact committed answer equality and worker terminal completion. Never
   count commentary as useful answer latency, turn missing timing into zero, or
   label an uncommitted partial body successful. Use identical bounded synthetic
   streams and pacing on baseline and candidate, include an unchanged normal
   control, and report raw repetitions rather than claiming a live-provider SLA.

Budget policy and product presentation are outside this change. Coordinate
common runtime edits before a single formal release.
