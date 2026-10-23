# Public answer instructions across native tool turns

Failure model: the v3 instructions contain a complete terminal JSON example but
describe a tool-bearing turn only in prose. A product instruction referring to
ordinary response text can therefore conflict with the purpose envelope. When
JSON response mode is incompatible with tools, the provider can return plain
companion content, which the runtime correctly withholds. The host must not
solve this by promoting untyped content, adding an introductory model call, or
reporting a tool result before its receipt exists. A provider may also propose
multiple native calls despite a configured single-call profile; this remains a
protocol failure, not permission to dispatch a partial batch.

The narrow change supplies complete examples for the existing v3 wire phases:
typed useful answer plus native tool with null outcome, and terminal null answer
after an already sealed body. Profile-specific instructions explicitly describe
the JSON-mode limitation and the single native-call limit. Useful content goes
in the existing answer field within the same necessary model call; progress
does not become an additional native call. Ordinary questions still use one
generation with no semantic reviewer. Unknown information still requires tools.

No parser, source schema, batch validation, authorization, cancellation, ledger,
replacement or completion acceptance rule changes. Prompt tokens are reserved
from exactly the profile-specific instructions sent to the model. The new v3
prompt policy is part of the provider fingerprint; v1/v2 instructions and
fingerprints remain unchanged.

The purpose envelope is transport encoding, not a user-visible assessment.
Exact formatting requests constrain the decoded answer. They never turn off the
wire envelope or require exposing its JSON to the user.

Recovered failures previously lost their detailed protocol classification because
only terminal `run.failed` carried safe diagnostics. Internal `model.failed` now
uses that same `publicModelDiagnostics` whitelist, including safe protocol code,
finish reasons and token counts. Its existing generic `RunEvent.data` record is
additive; no strict public-text envelope or event schema version changes. Error
messages, causes, payloads and unknown fields remain excluded. This does not
rewrite earlier events or change retry/cancellation/provider classifications.

Tests first assert the missing complete tool-turn example and single-call
instruction in the actual outgoing request. They then exercise typed same-turn
answer/tool streaming, strict terminal null-source behavior, profile and clone
identity, legacy instructions, existing source assembly and cancellation/raw
framing rejection. Synthetic responses verify contract plumbing, not real-model
compliance or latency. A candidate development build must pass a separately
identified isolated real-model qualification before formal publication; retain
failed qualification evidence and never relabel it as a successful release.

Upstream pattern: [LangChain structured output](https://docs.langchain.com/oss/javascript/langchain/structured-output)
selects provider or tool strategy according to actual model capability and notes
that simultaneous structured output/tools requires support. This patch keeps
the existing explicit text envelope and native tools; it does not claim the
unsupported provider mode works, import another execution loop, or substitute
an untyped text channel. Existing direct LangChain/LangGraph source reuse is
documented in `react-harness-reuse.md` and remains unchanged.

## Candidate validation

The added outgoing-request example checks failed before the prompt change, and
the failed-call diagnostic assertion failed before the event field was added.
After the changes, the TypeScript build and these offline checks passed:

- 58 tests across `public-purpose-tool-turns`, `runtime-diagnostic-privacy`,
  `react-wire-boundaries`, `purpose-native-tools` and `reasoning-effort`.
- Two actual PGlite-backed Worker scenarios selected by `full Worker` in
  `react-segments-runtime`: a plain-number answer uses one generation, no tools
  and no auxiliary review; A → tool → B → tool → null final uses three
  generations, two effects and no auxiliary review, preserving both sealed
  sources and the final body hash.

These are synthetic provider responses. They do not establish real-provider
format compliance or production first-useful-answer latency. Development live
qualification and exact-head CI remain separate release requirements.
