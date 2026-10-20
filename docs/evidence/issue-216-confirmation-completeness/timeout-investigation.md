# Follow-up failure model (before instrumentation)

The retained failed task is `memory-synthesis:ebd9de951bcddbf7bec671fcd20a12818ae0e1e9f0fb10793968a32c4dad92e6`.
Both attempts finish proposal and one repair model call, then fail before any
verification or apply action. The calls take 1.7–2.8 seconds. Existing terminal
privacy correctly replaces the exception text with a generic failure, so the
stored evidence does not identify the failed proposal invariant.

Do not infer provider timeout or budget exhaustion from the later test Abort.
The test permits 600 seconds overall and 240 seconds for extraction; the
207-second Abort is a separate operation failure. Keep both failure paths and
their timing separate.

Add a bounded internal validation event containing only a fixed phase/reason
enum. Never include proposals, evidence, error messages, IDs, bodies or prompts.
An invalid first proposal can still use the existing single repair; an invalid
repair must fail without approval or cursor advancement. Test this red first.
Any subsequent provider call must target the preserved failed page and existing
budget, not repeat the full product scenario blindly.

## Findings and limits

The original synthetic database is retained unchanged. Only a clone named
`lingxiloop_memory_continuity_diagnosis_test` was used for the recovery probe.
No production database or provider configuration was changed.

- `timeout-timeline.json` establishes that the two failed attempts stop after
  successful proposal/repair calls, before verification or apply. Their budget
  was 4/24 calls, 12,582/300,000 tokens and 15,930/400,000 costMicros; the last
  deadline was 06:22:45Z, after the outer Abort at 06:20:18Z. The overall test
  allows 600 seconds, and its extraction loop allows 240 seconds. Neither of
  those fixture limits fired. This does **not** exclude a shorter operation
  timeout or lock wait; the original stack does not identify its owner.
- `retained-offline.json`: ten product `memory.reflect` calls in passive control
  mode took 20–36 ms, without provider requests. This excludes a consistently
  failing resolver for the retained state; it does not reproduce the active
  scheduler's concurrency or prove the original timeout fixed.
- `retained-page.json`: exactly one native due retry was run in the clone, using
  the existing GLM-5.2 route. Source ID, request version, input hash and segment
  range match the failed load. No clock, cursor, retry counter, cap, verdict or
  provider response was replaced. The third native attempt used two requests,
  took 8,417 ms, passed validation and independent verification, and committed
  one change. Cumulative usage became 6 calls / 18,712 tokens / 24,088
  costMicros: this probe added 6,130 tokens and 8,158 costMicros.
- The earlier two validation failures did not recur. Because their proposal
  outputs and invariant reason were not retained, their exact failed invariant
  cannot now be established. The new fixed reason event addresses that gap
  without recording proposal text, source identifiers, feedback or prompts.
- `retained-source-progress.json` shows the source already had one rejected
  page (`approved:false`, confidence 0.85) before the failing tail job. The
  resumed tail committed with confidence 0.82 and moved the cursor to 7/7, but
  the source correctly became **rejected**, preserving the earlier rejection.
  `job.status=succeeded` means the job completed; it is not complete-source
  acceptance. Automatic extraction and final new-room inheritance remain red.
- `diagnostics-red.tap` preserves the missing-diagnostic red case;
  `diagnostics-regression.tap` passes all 18 affected tests, including the prior
  17 page/synthesis checks. The diagnostic test verifies both failed proposal
  phases, no raw synthetic private text, no apply action and no cursor advance.
  This is a scripted owning test, not a real provider qualification.

No further full-product provider run was made. The smallest remaining evidence
needs are (1) a failing proposal's fixed invariant code and (2) phase/operation
ownership plus contention timing for the outer Abort. The original record cannot
recover those facts. The provider's successful third attempt is not evidence of
why attempts one and two failed. Do not change repair/retry limits, weaken review,
mark the source processed, or claim the full continuity assertions passed.

## Handoff status

The follow-up is local and not published. Reading GitHub PR36 returned HTTP 401,
including once after loading the saved environment's documented wrapper.
Authentication and credentials were not changed; no further remote operation was
attempted. The previously confirmed remote head is `7c9bc943ee42870f450926fda8d3ebb7447a024e`.
The local follow-up commit and bundle can be reviewed and transferred by the
integrator. No merge, package publication, deployment or issue closure occurred.

## Resume: confirmed proposal failure mechanism (before fix)

On 2026-10-20 the existing GitHub channel was rechecked as lyyzka with repository
push permission and PR36 was advanced normally to 6a022d52. No credentials were
changed. A fresh product qualification database preserved the original failure.
The same automatic tail again remained at 5/7; its proposal tried a duplicate
path and its repair tried to update a protected document. Four earlier proposals
also attempted protected updates. The unchanged validator blocked these writes.

The native model input currently puts protected explicit/locked records in the
same currentMemories collection as editable synthesized records, while telling
the model both to consolidate existing records and never modify protected ones.
Make the writable collection contain only editable records and provide all
protected records separately, explicitly limited to read/coverage/conflicts.
Keep the original batch and transactional validator authoritative. Do not filter
invalid changes into accepted empty changes. Test the partition and successful
new fact plus unchanged protected value before the implementation; retain the
existing rejection, version, epoch and coverage tests.

The protected-reference candidate's first page validates its proposal, receives
successful provider output for verification, then fails before apply. This
localizes a second defect to the verifier response shape. A malformed verifier
must never authorize writing. It may consume the same single repair allowance
already reserved for this page and request a fresh independent, well-formed
verdict. Do not retry transport/cancellation or an already-used allowance; a
second malformed verdict remains pending. Keep the four-call maximum. Record
only the fixed names of invalid verdict fields, never their values or feedback.
