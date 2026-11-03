# Native-v3 required selection

The native-v3 receiver requires native calls for both public output and business
work. Its request now uses `tool_choice:required` over the unchanged complete
catalog, with `public_answer` first. This does not force every turn to use
`public_answer`: business-only batches remain legal, as do mixed batches with
public output first and terminal public output without business tools. An
explicit authorized `requiredTool` still selects that exact business function.
The wire budget estimator uses the same choice as the HTTP request.

The OpenAI-compatible profile gains optional `requiredToolChoice`. Omission
preserves assumed wire support, like the existing tool-call profile capabilities.
Set it false when provider qualification establishes lack of support. A native-v3
configuration with false fails with ConfigError before HTTP; the driver never
retries an unsupported constraint as auto, drops the catalog, or promotes
assistant prose. Provider rejections remain failures and retain billable usage.
Real supplier capability qualification is required before release acceptance.

A no-native-call protocol failure now includes `native_call_missing` and an
accurate bounded-repair prompt requiring native tool_calls. It preserves existing
receipts and sealed sources, forbids repeat actions and restated sealed text,
and explains that the rejected batch did not dispatch business effects. Existing
runtime lifetime correction bounds, failure ledger and source replacement rules
remain in charge; this change does not grant another retry budget.

Safe structural reasons additionally distinguish operation kind, fields and
supersedes failures, and native type/function/index metadata. They are closed
local enums, never rejected values, parameters, provider prose or credentials.
No validation is relaxed. The native-v3 configuration fingerprint changes to
identify this request policy. Consumers must use their formal-package upgrade,
behavior-binding and provenance checks; do not rewrite saved bindings to make
existing work compatible. Native-v1/v2 retain their independent existing policy.
