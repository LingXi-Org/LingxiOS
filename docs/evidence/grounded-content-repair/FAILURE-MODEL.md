# Grounded content repair failure model

Synthetic cases, specified before implementation:

- A content, resource, or self-assessment repair receives findings without the candidate body. Empty provider output history must still preserve the exact draft, request version, artifacts and hash in the correction context.
- A reviewer proposes optional polish for an already fulfilled request. Optional suggestions must not spend a generation or make the outcome partial; legacy missing findings remain required, and native verification failures remain independent.
- A candidate explicitly declares a fixable missing deliverable while the reviewer returns no missing items. Preserve the limitation/request association and attempt real repair within the existing correction cap.
- A required input is explicitly unavailable under an exact human constraint. Preserve an accurate partial result and request for input, without repeated paraphrase attempts. Agent claims alone cannot establish this blocker.
- New human steering invalidates the old candidate's repair context; no old targets or draft are injected as a correction for the revised request.
- Cancellation, root model call/token/cost/time budgets, correction checkpoint restore, peer handoff, final verification, and effect reconciliation continue to bound all repair paths. Existing owning tests cover these invariants.

Validation: owning content-check, conversation-content-repair, runtime and outcome suites; typecheck; full unit suite when feasible. No production data or external effects are needed.

## Direct loop default

- Ordinary answers, compound requests, execution mode, revisions, artifacts and tool receipts must not infer a paid semantic review. No classifier/router model is added.
- Partial self-assessments retain gaps and finish partial by default; they cannot create blind rewrite loops or become satisfied merely because review is disabled.
- Explicit trusted semantic review remains available with frozen execution configuration. Existing reviewer tests must opt in visibly.
- Native resource/file checks, action reconciliation, identity fences, citations, authorization, cancellation and budgets remain independent and unconditional where applicable.
- Synthetic before/after counts: a partial self-assessment with a human-unavailable input previously issued 3 generations and 1 review; reviewed repair issued 1 generation and 1 review. Direct default must issue 1 generation and 0 semantic reviews while retaining partial status.

## Control-plane acceptance

The commit path must read the immutable Worker behavior binding rather than independently reintroducing the retired request-wording heuristic. Explicit disabled mode permits direct commits only after the existing action, resource, artifact, request-version, native-obligation and assessment checks. Required mode still requires a matching current candidate review. Legacy bindings retain legacy semantic acceptance rules; new Workers reject their execution rather than reinterpret them. Binding records must have the fixed runtime identity and full configuration shape, be inserted for the current request version, and remain immutable.

Before changing this gate, synthetic completion tests failed for direct disabled commits, optional suggestions, required declared limitations and forged binding shapes. After the gate change, all eight completion tests pass. The full HTTP/model/Python artifact integration test exercises direct local and remote workers (two model generations, zero content reviews), and separately creates an explicitly reviewed Worker for revision-semantic coverage.

## Governing prompt

The platform instructions must not promise an independent evaluator when the default uses direct execution. Before changing instructions, the compiled delivery-section snapshot/version test and three actual direct-generation instruction tests failed. The new prompt contract is `prompt-v3.3`: check original requirements, revisions and actual receipts in the same generation, complete feasible authorized tool work before final delivery, preserve known partial/blocked outcomes only through the existing response contract, and keep private reasoning internal. This introduces no model call or response field.

## Trusted selective workflow review

- Default mode is explicitly pinned `selective`. No trusted nomination means zero judges; generic native gaps must never resurrect semantic review.
- A trusted control-plane resolver receives only current-request steps plus the actual registered/authorized catalog, request and candidate. It may nominate a bounded scope and rubric; no selection grants permission, activates a skill or resolves delivery.
- An explicit creation request with a loaded but unactivated workflow and a promise-only answer receives one focused review, one existing bounded repair chance, then truthful partial if the same scope remains. A reference-only explanation remains satisfiable without authoring activation. Ordinary answers receive no nomination and no judge.
- Scope/rubric/request changes, revocation, malformed nomination, disabled review, stale identity, and a positive review reused for a changed body must fail closed. Native action/artifact checks remain independent.
- Persisted review/checkpoint state prevents a worker restart or unrelated observation from buying another review or rewrite. Existing required generic review semantics retain their original bounds.
- Tests were added before implementation: four nomination-path tests and three once-per-scope/recovery tests failed, then passed after scoped runtime changes. The app integration test exercises the actual resolver, action ledger and final commit path with zero authoring activations.

Independent review reproduced interruption after the paid scoped judge but before review persistence: recovery spent a second judge. The owning regression fails before the fix. Scope admission is now durably written before the paid call and the same immutable step is completed afterward. An incomplete admitted review remains inconclusive on recovery and never purchases another judge. The post-result persistence recovery case remains covered separately.
