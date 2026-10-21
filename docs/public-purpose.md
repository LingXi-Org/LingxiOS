# Public text purpose, generation contract and rollout

Tracking: [LingxiLoop #280](https://github.com/LingXi-Org/LingxiLoop/issues/280), remaining work of #275. This is an unpublished **3.7.0** release candidate based on formal 3.6.0. The package, lockfile root and runtime declaration are aligned at3.7.0. The sole release owner performs publication only after exact-main release gates; this PR does not publish a package or tag.

## Public contract

`OpenAIChatDriver` / public Worker `model` configuration accepts opt-in `publicTextProtocol: 'purpose-json-v1'`. Absent means the existing plain text behavior. `releaseVersions.publicText === 2` advertises reader support, not producer activation. The generation contract is an ordered JSON object:

```json
{"commentary":"Checking the available record.","answer":"The record contains 42."}
```

Both strings are public. Commentary is concise status; answer is substantive user-facing content. Neither requests or exposes private reasoning. Native provider reasoning fields are never decoded. Tool calls retain their existing native channel. A tool turn may include a substantive answer, including an answer prefix before the tool executes; tool presence never changes its declared purpose. A final turn requires an answer. Format violations consume the existing bounded protocol-repair budget; root model limits do not increase.

The adapter requests JSON object mode and validates the exact order/schema itself. [OpenAI's structured output documentation](https://developers.openai.com/api/docs/guides/structured-outputs) distinguishes valid JSON from schema adherence; API compatibility does not prove a configured provider supports this combined mode. The parser retains at most 4096 framing characters, one escape/surrogate, and one current incoming chunk, with a 256000-character total output bound. It releases decoded text per provider chunk before EOF. Existing safety approval/ACK batching still applies.

Public model callback `onTextDelta(text, {purpose})` carries the declaration. The runtime publishes immutable v2 public.text events with required `purpose: 'commentary' | 'answer'`. V1 has no purpose and remains unknown. Per attempt, commentary is partIndex0 and answer is partIndex1; each has its own identity, safety state and termination. Publication authorization, request revision, fence and frozen audience checks are unchanged. Native app commit rejects a commentary source even when a forged candidate step matches its body hash. Only the existing final-result transaction marks an answer accepted.

Framing guarantees **which purpose the producer declared before a character was emitted**, not semantic truth of arbitrary prose. A noncompliant model could still label progress as answer or substantive text as commentary. The instructions address mixed prose, and deterministic tests prove routing for compliant declarations. Actual model compliance has not been tested against a real external provider; this is a stated limit, not a requirement for an additional broad model evaluation or a blocker to a reader-only release. The UI retains commentary in accessible history; this is not private reasoning or a content-classification mechanism.

## Reader-first upgrade and rollback

1. Formally release the reviewed upstream package with reader support. Pin that exact version and lockfile in the product; a source overlay is only local development evidence.
2. Upgrade every Web/API/SSE/history reader and Worker to that formal package **with producer option absent**. Qualify the configured provider's JSON-object + tools + streaming, first-character routing, final output, cancellation and malformed-response behavior. No production data is needed for this qualification.
3. Enable `purpose-json-v1` only after all readers support publicText2. The companion product draft enables it, so do not merge/deploy that draft before the prior steps and exact-lock update.
4. To stop producing v2, disable the option and drain/replace active producers according to the normal release path. Keep v2-capable readers: already-written v2 JSONB persists and old strict 3.6.0 readers reject it. Disabling a producer does not undo history. **No direct rollback to 3.6.0 after v2 writes.** Retain the upgraded reader and fix forward; do not delete or rewrite durable events.

No SQL DDL or checksum changes are needed: events use existing JSONB. Native schema14, product schema50, control-plane protocol11, kernel protocol2 and assistant-message2 remain unchanged. Public text changes from event v1 to opt-in v2. Same database schema does not imply reader downgrade compatibility; release compatibility must include this new public capability and stored history.

## Evidence and remaining release gates

Failure model: `docs/public-purpose-failure-model.md`. Tests use deterministic synthetic provider streams and isolated PGlite native app/Worker with actual persistence, SSE and replay. No production API, credentials, private conversations, HTML or restricted diagnostics were read. No external model request or browser qualification was run. Existing authorization, cancellation, safety, fencing and atomic final-commit tests remain mandatory owning checks.

The existing product same-schema release driver is intentionally restricted to formal runtime3.6.0/native14/product50 and equal formal keys. The3.7.0 reader upgrade does not qualify for that driver merely because schema14 is unchanged. The sole release owner must separately review a runtime/public-reader upgrade plan; do not relax or reuse the current guard. This draft changes no release driver.

Both tool-turn and final-turn answers stream incrementally before provider EOF. Tool-turn answers end with reason `tool` but keep purpose `answer`; they remain current foreground text in the product until a later attempt supersedes them. Only the existing no-tool final-result transaction can mark its answer part accepted. The contract does not promise that tool execution begins before the provider finishes specifying the tool call. No substantive answer is moved to commentary to satisfy the wire contract.

See [3.7.0 release preparation](release-3.7.0.md) for formal package qualification, the separate reader-first deployment gate, and minimal producer compatibility behavior.
