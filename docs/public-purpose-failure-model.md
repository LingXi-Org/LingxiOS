# Public purpose contract: failure model before implementation

Issue: LingXi-Org/LingxiLoop#280, remaining scope of #275.

The wire contract is opt-in `publicTextProtocol: 'purpose-json-v1'`: exactly an ordered JSON object `{"commentary":"...","answer":"..."}`. Both fields are public. Commentary contains concise user-facing progress only, never reasoning. Answer contains substantive user-facing content only. This proves a producer declaration, not semantic correctness of arbitrary model prose. JSON mode itself does not guarantee schema/order: the adapter validates both incrementally. Private provider reasoning fields are ignored.

Failure boundaries:
- A first delta without a validated field name must never enter the purpose-aware public channel. Unknown/duplicate/reversed fields, extra trailing bytes, invalid escapes/surrogates, oversized framing or incomplete EOF fail with a closed protocol error; no raw-text fallback. Body text streams before EOF without buffering the whole answer.
- Cancelled/failed partial output remains incomplete, fenced, and cannot become accepted final. Publication ACK failure is not a provider retry. Existing root budgets and two protocol corrections are unchanged.
- Purpose is immutable part identity. Each attempt has commentary index 0 and answer index 1. Switching back or dropping metadata fails. Both pass the same cumulative safety and product authorization gates; no private-channel input is published.
- A tool turn may contain commentary but not an answer. An answer-only/final turn must contain a nonempty answer. Empty content with native tool calls remains legal. A malformed answer with tools must not execute those tools.
- Model wrappers must preserve metadata, capability and configuration identity; fallback drivers must match protocol capability. Legacy events are version 1 without purpose; new events are version 2 with required commentary/answer purpose. Old readers cannot consume v2: enable only after a formal upstream runtime release and all readers are upgraded.
- Existing JSONB events carry the new data. No database migration, release version bump or dependency publication in this draft. Native schema remains 14, product 50. The public event protocol is explicitly versioned independently.
- Durable storage, SSE, replay and committed source binding must agree. Commentary cannot be an accepted-answer source even if a worker supplies its ID. Only the existing transaction commits acceptance.
- Product projection must use public purpose metadata, preserve genuine answer streaming and activity history, and not resurrect removed aggregation UI. Legacy unknown remains legacy behavior; no language heuristics.

Planned evidence: deterministic split provider stream, malformed/truncated/bounded/cancelled stream; native PGlite worker + tool + persistence/SSE/replay/accepted final; existing public-text authorization/fencing and callback regression. Actual external provider compatibility remains unverified until a separate authorized qualification; no restricted production data is used.

Additional review before tightening: EOF schema failures must retain already observed provider usage for the shared ledger. The added wire instructions must count against context admission. Cancellation inside the first decoded field must prevent later fields in the same provider frame from being delivered. These need focused counterexamples before fixes.

Independent review found protocol overhead was incorrectly added to generic inputTokens(), including history estimates and auxiliary calls. Counterexamples must prove unchanged history/auxiliary estimates, one extra charge only for agent-turn reservations, and near-limit auxiliary admission while the larger main wire request is rejected. Correction must use explicit main-wire accounting, not a blanket conservative surcharge.
