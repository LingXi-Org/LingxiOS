# 3.8.0 public execution trace release candidate

The designated integrator assigned runtime/package3.8.0 and `releaseVersions.runTrace=1`.
Control-plane11, kernel2, native schema14, assistant-message2 and publicText2 are
unchanged. No SQL file, dependency resolution or public-text producer setting
changes. This branch does not merge, tag, publish, change production or authorize
another publisher. Product migration0052 is reserved by the integrator for the
exact3.7/full51 to3.8/full52 provenance transition, independently of native DDL.

The new public API is `readRunTrace(identity, operation?)`; live replacement
snapshots require `streamRun(identity, { trace: true })`. Omitted/false trace
keeps the existing SSE shape. Start metadata is additive to existing event JSON;
settlement metadata is additive to the existing model observation JSON. No new
durable event kind or hidden reasoning is exposed. Existing public text v2
history and reader restrictions from3.7 remain: trace opt-out cannot make3.6
readers compatible with v2 history.

Use formal PR checks, then the exact merged-main release qualification before
the sole release owner tags and publishes3.8.0. Verify actual registry integrity
and compiled `runtime=3.8.0`, `schema=14`, `controlPlane=11`, `publicText=2`,
`runTrace=1`. Product consumers then use the exact official dependency/lock;
source overlays are test evidence only. The separately reviewed product
provenance migration and deployment guard must admit this exact runtime; do not
weaken the3.7 guard because SQL bytes happen to match.

Keep trace opt-in off for consumers that do not recognize the new union member.
Old default SSE reads remain structurally compatible; deployment rollback still
requires the recorded product/runtime provenance and existing public-text reader
capabilities. No blanket rollback claim follows from additive JSON or no DDL.

[Public contract](public-run-trace/contract.md) and
[targeted evidence](public-run-trace/evidence.md) describe true timing/usage,
visibility/truncation, local settlement and unknown remote effects. No production
provider latency or private-user-case verification is claimed.
