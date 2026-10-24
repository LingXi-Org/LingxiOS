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

The native-v1 request policy selects `tool_choice: required` over its full
already-authorized business/output catalog. It does not force a particular
function. The private-v2 and opt-out paths retain `auto`. A provider rejection
of required mode remains a failed call with its real HTTP status; the driver
must not degrade to auto, change the model or make an extra compatibility call.
This policy is separately fingerprinted, so old bindings cannot silently reuse
its changed behavior.

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
