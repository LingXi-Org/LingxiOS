# 3.8.13 internal worker failure diagnostics

The worker now preserves a bounded internal diagnostic before converting an
unexpected exception into the existing public failure text. It records the
runtime phase and binding state, safe exception classification and codes,
fixed native source frames, run/request/fence identity and an optional immutable
deployment SHA. Original messages, raw stacks, queries and payloads are excluded.

The trusted `readDiagnostics` API exposes only a validated diagnostic for the
current request and fence. Ordinary event readers and public terminal errors
retain their existing behavior. Diagnostic sink failure does not change the
terminal outcome; cancellation and lost-lease handling remain unchanged.

The focused worker tests cover failures before binding and while saving the
binding, persistence, operator validation, public privacy, request/fence
filtering, a failed diagnostic sink and cancellation. These synthetic cases
verify diagnostic behavior, not the cause or resolution of any historical
production failure.

This release changes the package and compiled runtime identifier to `3.8.13`.
Native schema 14, control-plane 11, kernel 2, assistant-message 2, publicText 3
and runTrace 1 are unchanged. No database migration is required. Consumers must
pin the formal registry package and verify its integrity and compiled versions.

See [the operator API and privacy contract](runtime-failure-diagnostics.md).
