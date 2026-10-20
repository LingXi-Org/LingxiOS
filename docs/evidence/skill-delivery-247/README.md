# Public authoring activation and delivery obligations

Related product defect: https://github.com/LingXi-Org/LingxiLoop/issues/247. Base is LingxiOS `35ac1208fcf2bd6cb1852f474175e9eb7e2083ec`. This is an upstream draft, not a runtime release or a claim that the retained model-quality failures now pass.

## Public contract

A skill may opt in with `delivery: { checker: 'product:diagram' }`. Its existing version/content hash includes this declaration. `skills.load` remains a reference-only read. The separate native `skills.activate` takes the exact indexed name/version/hash and creates a bounded, transactional authoring intent under the existing principal, tenant, run, request version and capabilities. Ordinary examples, references and export alone do not activate it. There is no model-facing resolve tool.

Both `verifyRun` and the new `LingxiOSOptions.verifySkillDelivery` receive `RunVerificationContext.skillActivations`. Each typed activation contains its ID, tenant/run/request version, exact skill name/version/hash and product checker. `unavailableSkillActivationIds` identifies revoked capabilities or changed skill contracts. The dedicated native table is the source of this projection; the product never needs to inspect private action receipts, execution steps or caller-supplied metadata.

`verifySkillDelivery` returns bounded `SkillDeliveryDecision[]`: `{ activationId, outcome, evidence }`, where outcome is `delivered`, `unsupported`, `failed`, or `pending`. Missing decisions stay pending; unknown IDs, duplicates and malformed/oversized decisions fail closed. The callback is trusted application code: it must independently authorize and read the actual artifact, check that the candidate references it, and verify relevant content. A successful save/hash is not quality evidence. For unsupported/failed, it must verify an honest user-visible explanation. Revoked/changed contracts cannot produce a passed delivered decision, but may produce a verified non-delivery explanation.

Candidate checks do not resolve or commit delivery. The final message transaction repeats the trusted verification and stores the disposition with the actual candidate hash. Pending authoring blocks terminal satisfied/partial/blocked messages. Unsupported/failed resolve non-delivery but cannot commit a satisfied outcome. Awaiting input/approval or delegated work preserves the pending obligation; the existing waiting receipt checks still apply. Cancellation and a superseding request do not fabricate delivery. Every new request version needs its own explicit activation.

Activation never grants business permissions and never counts as a business action's successful delivery. Existing skills without a delivery declaration retain their prior load behavior and hash. Existing `verifyRun` signatures remain valid; context fields and the optional callback are additive. Applications opting in must configure their trusted verifier and instruct authoring to call the explicit activation action. This mechanism guarantees enforcement for activated work; it cannot infer whether a model should choose a chart or compel activation from ordinary prose/code. It uses no keywords or private protocol heuristics.

## Transaction-scoped capability resolution

`CapabilityResolver.resolve(work, context?)` now receives public `CapabilityResolutionContext.database` from the app. Database-backed policies must use this queryable and pass it through their own helpers, e.g. `const db = context?.database ?? pool`. During `skills.activate` and final verification it is the existing transaction connection. Native conversation and delegation-lineage authorization, current-work policies and ancestor policies all reuse it. Checks stay fresh under the existing locks; no authorization result is cached. One-argument pure resolvers remain source-compatible. A resolver that ignores the new context and closes over its own pool can still deadlock and must be updated when enabling delivery; the runtime cannot redirect arbitrary consumer closures.

The final guard rejects a satisfied envelope when the trusted decision is unsupported/failed. This is not proof that AgentRuntime automatically converts an inaccurate model assessment to partial: current short coverage commits an explicitly honest partial response via the public host. Product verifier/envelope integration must honor that boundary; pending and non-delivery are not a claim of fulfilled work.

## Schema and upgrade boundary

This draft requires native schema14, with a dedicated `agent_skill_activations` table and startup probe. Migration `016-skill-delivery.sql` explicitly upgrades13→14, rejects absent/wrong source provenance, and requires drained Workers. Operators must also stop/drain Web background work before applying it. Runtime startup never executes DDL. Immutable `schema-013.sql` is byte-identical to the base's schema, and is included in package resources and the Worker image source. Existing schema13 rollback tests explicitly use that historical snapshot; the current upgrade chain includes016.

Do not apply old migration015 rollback to schema14. Keep activation/resolution data and use a compatible fix forward; no destructive rollback is introduced. This draft leaves the package/runtime release number at the existing development baseline. Before publishing, the sole release integrator must assign a new formal runtime version, qualify/package it, and then update product locks and product migration orchestration in a separate native-upgrade batch after the current product49 release. Nothing here publishes, installs or deploys that version. No product locks or production state were changed.

## Actual validation

The [failure model](FAILURE-MODEL.md) and targeted tests preceded implementation. Initial compiler red establishes the missing public API. A short owning run exposed duplicate `skills` namespace grants; after that correction, separate red cases exposed counting activation as business delivery and blocking input wait. Independent review identified and confirmed the fixes for all four authorization/liveness/business-evidence issues. A final migration counterexample exposed SQL NULL accepting an absent schema singleton;016 now uses a null-safe source guard.

- Full TypeScript build passed (existing dependencies, Node22.23.3; no installation).
- Targeted tests: `skill-delivery`, `harness-regressions`, `memory-continuity-rollback`: **12/12 passed, 0 skipped** using local PGlite, no network/provider.
- These cover public activation/load separation, exact bindings/deduplication, tenant exclusion, cancellation/supersession, malformed/omitted decisions, revoked capability fallback, no candidate-time resolution, final commit recheck/rollback, pending input-wait preservation, business-evidence exclusion, native13→14 provenance and old rollback rejection.
- Two existing historical-upgrade compatibility cases also passed (collaboration fresh-schema equivalence and memory reset preservation); only their migration lists and the existing PostgreSQL store script were extended with016. The full PostgreSQL script was not run.
- The initial review cleared the four reported fixes and migration guard. A subsequent independent single-connection review found pool reentry; the new counterexample and correction are recorded below, superseding the earlier blanket clearance.
- Retained logs and `SHA256SUMS` are adjacent. Repeat: `npm run build`, then `node --test --test-concurrency=1 dist/test/skill-delivery.test.js dist/test/harness-regressions.test.js dist/test/memory-continuity-rollback.test.js`.

No provider/browser, long soak, production request, merge or release was performed. Original product provider failures remain red. Actual app wiring to this future public API and generated HTML diagram-box coordinate/size correctness outside the numeric renderer remain separate product implementation slices; CSS zoom and numeric PR253 do not cover arbitrary generated boxes.

## Pool-reentry correction

A second independent public-API reproduction showed the original c8c90 activation path blocking on a single-connection pool. The added regression models serialized access and fails immediately on reentry during an open transaction; ordinary parallel reads still serialize. Before fix activation rolled back; after passing the current queryable it completes with zero reentries. The same case covers child ancestry, parent cancellation/reinstatement, fresh grant revocation between candidate/final checks, rejection of a delivered decision after revocation and a valid honest unsupported final commit.

Full build and the same owning suite now pass **13/13,0 skipped**. New `pool-red.log`, `pool-green.log`, `pool-build.log`, `pool-owning.log` retain this bounded evidence. No provider/browser/production, runtime publish or product lock changes. Independent re-review of the new correction is pending until its exact updated commit is handed off.
