# Forgetting and durable model input

Source correction: `ea1a9b3bbbc4939f6e2ef45d3405224ff88ed61b`, based on the normal merge `5272111` of the fixed continuity changes and initial model-admission change. Final tested source: `e8f4942181802433b52d9d9e6ba946dd2d2f31a2`, a normal merge of that correction and revised admission `a942671cb5915a80946e1982de4fda49f9e6de5e`. No history was rewritten. No additional schema migration, package version, dependency, production action or provider call is part of this correction.

The original failure model and count receipts remain in this directory. The original minimal compactor always returned the synthetic marker, even when its input no longer contained it. Before implementing the correction, the owning fixture was corrected to derive that marker only from its actual input and given ordinary user text to keep real compaction eligible. `baseline-receipt-red-v2.txt` records the same true red. The corrected fixture also ran against the immutable `3628e9e7` archive: all three scenarios failed (`baseline-corrected-red.txt`), including a summary really created before forgetting and an old-format summary without provenance.

## Behavior

Native memory tools capture scope epochs under the same transaction and scope lock as their read and durable receipt. Model history carries that provenance through direct tools, Python receipt groups, recovered receipts, intermediate model output and derived summaries. Observation ranges retain their original receipt provenance. The runtime compares it with the current, server-authorized memory scope snapshot before both main and compaction input. It never assigns today's epoch to an old receipt or summary.

An invalid dependency replaces only the model projection of that observation/tool pair or summary with a fixed unavailable observation. Original user text, already-public final answers, session records and idempotency/recovery receipts are not deleted by forgetting. Current authorized memory remains available. Ordinary tool history and the public default compaction interface retain their existing behavior. Normal compaction can still replace history through its existing optimistic installation checks.

Old histories have no epoch proof. When an old summary or Python cell requires it, the server checks same-tenant/agent/principal/session/thread action identities and historical memory-injection counts, without reading receipt bodies. Unproven memory-derived summaries are withheld rather than stamped with a new epoch. Cell evidence is bounded to 256 identities; overflow conservatively withholds unproven Python observations. New, proven history skips this legacy lookup. Dependencies are bounded to 144 scope/epoch entries; conflicting epochs or overflow cannot become clean proof.

A contaminated mixed summary temporarily loses its ordinary details in model input too. Its original durable text remains. The current authorized `context.messages` are rendered through the existing bounded turn-input policy, so original human messages and public answers are still available. This is a conservative compatibility tradeoff, not a new summarization/model call or a session reset.

Provenance and admission fields are control data. `memorySnapshotBody` excludes `admission`, `admissionRequestVersion`, `sourceEpochs` and legacy-evidence fields from default and custom dynamic-context renderers and memory body accounting. Item provenance is stripped before provider/compaction input and token accounting. Receipt renderings omit it. The final model-admission proof remains server-owned and independent; the merged context keeps argument 4 as the expected request version and argument 5 as the legacy-history hint.

## Verification

All inputs and model responses were synthetic. Integration uses actual `createLingxiOS`, `AgentRuntime`, native tools, persisted PGlite and different Node processes. It does not claim real PostgreSQL network cancellation, a configured/live provider, production failure injection, full production compatibility or a long soak.

| Scenario | Before | Fixed source |
| --- | --- | --- |
| Native receipt, next run after forget | private marker in model input: 1 | 0 |
| Compaction after forget | private marker in compaction input: 1 | 0 |
| Process restart after forget | private marker in model input: 1 | 0 |
| Summary actually derived before forget, warm/restart | private marker in model input: 1 | 0; original summary still contains 1 |
| Legacy summary without provenance, warm/restart | private marker in model input: 1 | 0; original summary still contains 1 |

`final/*-counts.json` records three scenarios and six independent processes at exact source `e8f4942`. Original requests and committed answers have private-marker count 0. The first provider input has count 0; the authorized native receipt and pre-forget summary have count 1. After forgetting, every main/compaction/restart input has count 0, as do the control-field counts. The summary scenarios preserve authorized original-user and public-answer facts, and confirm that forgetting leaves the original session/summary/ledger unchanged.

- Build: passed (`final/build.txt`).
- Projection and two-process owning regressions: 9/9 (`final/targeted-green.txt`; before the admission merge, same history correction).
- Exact combined source owning run: 145/145, 59.89 seconds (`final/owning-green.txt`). Includes runtime, compaction, memory context budgets, optional memory, native memory, both model-admission suites, diagnostic-memory compatibility and the nine new regressions.
- Pure controls cover revoked scopes, ordinary tools and summaries, mixed/conflicting epochs, repeated projection without restamping, legacy cell identities, control-field budgeting and server-count evidence scoped to the current principal.

Reproduce the owning boundary after a normal build:

```sh
node --test --test-concurrency=1 dist/test/memory-history-projection.test.js dist/test/memory-session-forget.test.js
```

The fixture's optional `LINGXIOS_FORGET_FIXTURE_ROOT` selects an immutable local baseline build for the red comparison. It never selects a network database; each test creates and removes only its own PGlite directory. The existing paused soak is untouched. Independent review and the release owner's combined CI, formal package and product gates remain separate from these local results.
