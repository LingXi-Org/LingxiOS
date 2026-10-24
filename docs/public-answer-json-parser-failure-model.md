# Native public answer JSON member order

The native `public_answer` function exposes a JSON Schema object. JSON object
members have no ordering semantics. The d5ee compiled driver nevertheless uses
the ordered assistant-content parser: a schema-valid `commentary` after `answer`
is rejected after its answer characters have already been provisionally emitted.
This synthetic reproduction does not establish the unknown tail key in a prior
real response.

The fix is scoped to the native output binding. Reuse `@streamparser/json` for
JSON tokenization/grammar; keep the original business schemas, native call
identity, whole-batch limit, completion checks, outcome constraints and legacy
assistant-content protocols. Detect duplicate members at every object depth
before JSON.parse can erase them. Unknown fields, incorrect types, invalid or
truncated JSON and lone Unicode surrogates remain errors.

A complete validated operation is required before text publication. If answer
arrives first, buffer it within the existing limit until operation validation;
never guess append/replace. Operation-first answer strings still stream before
their closing quote and full arguments. Published deltas remain provisional:
late invalid fields, cancellation, invalid completion or a second native call
must prevent a successful model result, durable seal and business dispatch.
Ordinary content and reasoning remain private. This change adds no model calls,
judge, permission, prompt task requirement or budget increase.

Tests exercise the actual OpenAIChatDriver with local synthetic SSE frames,
not a second parser implementation. The existing Worker public-answer safety
suite supplies durable sealing/dispatch coverage. No real provider or database
operation is needed for these parser regressions.

The frozen fa8 candidate selected `tool_choice: required` over its full
already-authorized business/output catalog. It did not force a particular
function. Private-v2 and opt-out retained `auto`. A provider rejection remained
a failed call with its real HTTP status; no runtime fallback was installed.
That policy was separately fingerprinted, so old bindings could not silently
reuse its changed behavior.

Before implementation, the frozen d5ee driver produced **29 passes / 5 failures**
in the 34-case parser suite (`public-answer-json-parser-baseline-red.log`). The
failures reproduce legal member order, delayed operation and trailing commentary
compatibility. The required-policy run produced **1 pass / 2 failures**
(`public-answer-required-policy-red.log`), with the opt-out/private control
passing and both native payload assertions observing `auto` instead of
`required`. These runs used only local synthetic responses.

Final local verification is split across preserved runs: the initial parser and
native-driver suite passed **58/58**; the final non-string-operation and exact
wire-budget checks passed **2/2**. One of those two is an expanded existing
required-policy case, so this is **59 distinct parser/driver tests**, not 60.
The unchanged native Worker recovery suite passed **14/14**, and the explicit
explanation-stage Worker path passed **1/1**. Together they cover **74 distinct
cases** across these runs. The final build passed. Expected outbox-acknowledgement
warnings occurred in deliberately fault-injected recovery cases; they are not
hidden or described as a warning-free run.

Evidence files: `public-answer-json-parser-first.log`,
`public-answer-json-parser-final-delta.log`,
`public-answer-json-parser-worker.log`, and
`public-answer-json-parser-stage.log` under `/workspace`. The final added type
check ensures an array-valued `operation.kind` releases neither operation
metadata nor buffered text. The wire-budget check compares the actual counted
messages, full tool catalog, tool selection and parallel-tool policy with the
outbound request. Original baseline failures remain unchanged. No real-provider
success, production fix or explanation semantic acceptance is inferred here.

## Explicit auto compatibility candidate

The later fa8 live graph and independent arithmetic qualification each returned
three HTTP 200 responses with stop and no public content or native tool calls.
They failed before argument parsing or business dispatch. This establishes a
failed qualification for that provider/model/profile, not universal absence of
required-mode support. The original failed receipts remain unchanged.

This reversible candidate explicitly restores auto in the native-v1 request
and its wire-token estimate, with a new auto-v1 policy fingerprint. It retains
the field-order parser, strict public_answer output binding, whole-batch checks,
sealed-source recovery and explanation-before-authoring stage. It adds no
prompt, budget, model routing or runtime fallback. A request rejection is still
an error; an ordinary content response is still not a public answer.

The previous auto arithmetic run delivered 43 only after one protocol
correction: two calls, zero judge and zero retrieval. Thus this candidate does
not prove ordinary one-call delivery. The original receipt remains failed
under its original one-call assertion. The later authorized acceptance treats
one call as an optimization target and allows necessary bounded recovery,
provided delivery remains truthful, without replay or a general review loop;
the graph still needs substantive text before saving and real resource delivery.
This code preparation changes no qualification assertion and claims no success.
The existing correction limits and 250k qualification cap remain in force; a
provider may still fail to produce a valid output within those limits.

Local checks compare the exact estimated/request tool selection and catalog,
keep private-v2/opt-out auto behavior, and retain the schema-order regressions.
Only synthetic local fetch responses are used. No live qualification, release
or production readiness is claimed by these checks.

Compatibility verification: the frozen fa8 implementation failed the two new
auto expectations (wire estimate and actual request), while the private/opt-out
control passed. The existing correction-text assertion independently failed in
both tools=false/true cases because it named removed wording; only that literal
was aligned to the existing receipt-based instruction. After the three-line
source change, the parser/native driver suites passed 59/59, and those two
correction cases passed 2/2. The build passed; the final correction test's
string-only edit was then transpiled and executed without a second full build.
A constructor-only comparison against frozen fa8 confirms the native fingerprint
changed while opt-out and private-v2 fingerprints remained identical (zero
model requests). All checks are local; the next authorized full qualification
still needs to measure actual calls, early useful text and final delivery.

One additional stale wording assertion in the existing v2 public-outcome
repair test was independently reproduced and aligned to the same receipt
sentence. Its v2/v1 wire assertions remain intact, and the single affected
case passed. This brings compatibility verification to 62 distinct cases
(59 + 2 + 1) across the preserved runs, without repeating the 61 earlier cases.
