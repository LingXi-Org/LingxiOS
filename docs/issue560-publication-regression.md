# Issue 560: public output publication and bounded protocol correction

The installed production dependency is `@lyyzka/lingxios` 3.8.16. A synthetic
attention explanation plus interactive-view request through LingxiLoop's real
Worker, isolated PostgreSQL/Redis, recording IM, and the existing authorized
DeepSeek-V4.1-Flash provider reproduced three failed generations. The provider's
first two complete captured responses contained valid JSON with root member order
`operation, answer, commentary, outcome`. Public publication rejected commentary
after answer, without a protocol code, before any business action ran. No prompts,
reasoning, credentials or raw provider arguments are included in this evidence.

The native JSON parser already accepts unordered object members. The downstream
attempt writer still imposed the older ordered-purpose contract. Driver-only
parser tests therefore missed the failure. The fix permits first-arriving late
commentary only for v3. Both purposes still use their own safety-assessed durable
writer. Operation validation, source identity, sealing, duplicate/type checks,
full-batch validation, business authorization and delivery verification remain.
Invalid purpose errors now carry the existing closed `public_text_invalid` code.

A release-line local candidate passed the 24-order driver-to-writer regression
and an actual Worker synthetic save/verification regression. Independent review
ran 105 focused tests successfully. These tests do not establish provider delivery.

Two subsequent bounded real-provider candidate runs advanced past the original
failure and dispatched `skills.activate`, but neither saved a visualization or
completed delivery. They used 4 and 6 calls respectively. The last capture proved
that the provider also emitted exposed `visualize__read_reference` alone at
index 0, violating native-v2's required leading `public_answer`. Another call
reached an unknown tool-name prefix; the existing generic public-text error was
misleading. This patch keeps these responses rejected, classifies unknown names
as `tool_identity_invalid`, and preserves usage/finish reasons with the closed
`public_answer_first_required` code for business-only batches. Correction text
identifies the missing binding and same-generation business call requirement;
wire instructions reinforce exact exposed function names after skill observations.
The instruction hash automatically changes the native-v2 configuration fingerprint.
No budget increase, forced completion or tool-name alias fallback was introduced.
The final dedicated correction has deterministic coverage; it has not had another
real-provider run. Total real experiment calls: 13, across three synthetic runs.

Current-main owning check:

```
npm run build
node --test scripts/test-public-answer-publication.mjs
```

The 34 focused checks cover all 24 field orders, early streaming, malformed input,
late-commentary safety, legacy order, safe diagnostic projection, exact-name
correction, and missing-output-binding diagnostics with preserved token usage.
The package CI runs this focused file; no retired test harness was restored.
On the 3.8.16 source candidate, the final changed driver/diagnostic checks passed
39/39 after the earlier independent 105-case run (overlapping counts).

## Release and evidence boundary

This repository's main is currently `4.0.0-slim.0`, while LingxiLoop permits the
formal 3.8 patch line. This change alone is not a deployable product dependency.
The release owner must publish a compatible reviewed 3.8 patch containing these
changes (or separately qualify a major upgrade), then update the exact root/server
manifests and lockfiles and run product acceptance. A release-line branch based on
3.8.16 preserves the corresponding source and focused legacy tests for backport.
The isolated product experiment used only a process-local mapping of public package
exports; installed packages, manifests, production and real conversations were not
modified. This is explicitly unpublished-candidate evidence, not a formal release.

For the historical production run, the available internal records contain no
precise protocolCode or rejected subfield. There are currently no saved visualize
rows or activation/delivery receipts for that run. Historical deletion is not
excluded. The controlled reproduction proves a present defect, not the exact
cause of all three historical attempts. No real browser validation was performed.
Issues 515, 518 and 560 must not be called complete solely from these local checks:
formal publication/integration and an actual save→verification→delivery acceptance
remain outstanding.
