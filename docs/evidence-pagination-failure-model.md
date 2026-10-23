# Evidence paging contract: failure model

This investigation uses synthetic source text only. It does not establish the cause of any production conversation.

- A stored excerpt can be only part of its original source while its final page is fully consumed. Source incompleteness and remaining pages are different facts.
- A final page that retains `truncated: true` and an unchanged numeric `nextOffset` invites another empty read when a caller follows the tool description.
- A caller must stop on explicit end-of-excerpt; this must never imply that the whole original source was read.
- Source identity, version, marker, exact text and current authorization must remain intact, including recovery and replay.
- Large evidence must remain bounded in the prompt and durable bytes must not be rewritten or summarized into invented evidence.
- A tool range larger than the model-visible output budget must not silently look complete; any proposed paging design must account for the enclosing receipt and JSON escaping.

The focused regressions were first run against the previous implementation and failed on EOF, missing inline excerpts and lost range structure. The implementation keeps whole short excerpts inside the existing prompt budget and preserves a bounded, explicitly partial model view of large range results; receipts retain the original value hash.

The runtime scenario must also prove that substantive text derived from the supplied evidence becomes durable before a required artifact write, that the write and verification still occur exactly once, and that failure or cancellation cannot turn the early explanation into a completed delivery. A scripted provider measures transport/runtime timing only; it does not predict a real provider's latency or choice of tools. No auxiliary judge or reduced task budget is introduced.

A preparation hint may skip only retrieval already represented by the currently authorized frozen request snapshot. It must be computed by the control plane, never copied from work metadata. New requests, empty snapshots, and revised requirements remain eligible for retrieval. Current source authorization must run before the hint reaches the product, and source revocation must fail closed. This changes no binding comparison or durable budget.
