# Loop #515 / #518: protocol correction boundaries

Product companion: https://github.com/LingXi-Org/LingxiLoop/pull/517.
Base: `88cf667` (formal 3.8.13 source, including OS PR68 diagnostics).
No runtime version, schema, lock, publication or deployment change.

## Reproduced boundary and correction

For native `public_answer`, `completeCompanionTurn` parsed JSON before the
public-output parser could finish. A truncated argument object therefore
reported `tool_identity_invalid` and received generic tool correction. The new
Worker regression demonstrated that exact classification on the original
implementation. Identity/batch/finish validation is now separate from argument
validation: a correctly identified public output reaches its strict parser,
which reports `public_text_incomplete`. Business calls still pass the original
full JSON validation. No malformed output is sealed or dispatched.

The other synthetic fault omits the required `outcome` field. It correctly
remains `public_text_invalid`; the fix does not invent a default outcome or
accept malformed JSON. A complete malformed chunk fails before publication;
incomplete streamed answer text retains failed event endings and settled ledger
entries. Provider failure/retry classification is otherwise unchanged.

Protocol corrections now explicitly distinguish a terminal outcome for a fully
answered request from `outcome:null` for unfinished work. They explain null
terminal answers over sealed sources and explicit replacement of revisions.
This is guidance, not a semantic heuristic or a guarantee of model behavior.
Normal intermediate answer → business tool → null terminal answer still works.
The previous PR65 repair-source enforcement remains authoritative.

## Executed evidence

- `npm run build` passed (production/test TypeScript build).
- `node --test --test-concurrency=1` over the five built test files below:
  **136/136 pass, zero skips**, 53.25 seconds; [full output](focused.log).
  Files: `public-answer-tool-worker`, `public-answer-tool-driver`,
  `native-tool-companion`, `native-tool-public-output-driver`,
  `protocol-recovery-worker` under `dist/test/*.test.js`.
- [Machine report](protocol-corrections.json) contains each synthetic attempt,
  operation, ledger status, accepted segment and final body. One missing-outcome
  failure ends after 2 calls; two truncated failures end after 3 calls. Each has
  exactly one committed source and zero business effects/auxiliary model calls.
- A separate new Worker case runs failed protocol → intermediate answer →
  authorized synthetic save → null terminal answer: four calls, one effect,
  one verification, one committed source. Existing selected cases cover whole
  batch rejection, cancellation, lost seal/history acknowledgements, bounded
  corrections, request isolation, repeated call IDs, tampering and metering.
- All runs use the real OpenAI wire driver/Worker and disposable PGlite with
  deterministic synthetic responses; no live provider, browser or production
  operation was used. Existing fixture outbox shutdown warnings are retained
  in the log, not represented as real IM delivery receipts.

The first new-test run exposed a fixture SQL column typo (`work_id` instead of
`run_id`) and an incorrect expectation that a wholly invalid chunk emits text.
Those fixture errors were fixed before the passing run. The pre-change failure
also established the actual truncated-output misclassification and absence of
explicit completion guidance.

## Unverified production cause and handoff

Read Loop #515, #406/#341 history, OS PR65 and Loop PR420/491. The old explicit
replacement work is not reimplemented. The reported A run could have legally
continued after an intermediate response, but no original restricted wire
payload, failed protocol field, terminal declaration or deployed runtime
identity is available here. This source fix does **not** establish A's root
cause, eliminate all semantic restatement, or justify closing #515. The product
PR separately fixes the directly reproduced B projection leak on formal 3.8.12.

The parent hands both PRs/SHAs to the sole #514 release coordinator. Any use of
this upstream code requires normal package publication, exact downstream locks
and exact release CI owned by that coordinator, coordinated with #491's 3.8.13
adoption. No local package is substituted into the product. Production acceptance
needs actual runtime identity and the authorized run's protocol/phase evidence;
do not resend a student message or mutate an old run to obtain it.

## #518 continuation and publication evidence

Read the new #518 issue and its notification comment. Its discarded-draft
projection is shared with #515-B and fixed by product PR517; its first-success
then publication-failure chain is a separate boundary from a first protocol
failure. No timeout or correction-limit change follows from a roughly 30-second
failed call. The issue provides source/tag metadata for OS3.8.12, not original
wire declarations or independently inspected container bytes.

The native runtime now records `response.continued` internally only when it
actually takes the intermediate-outcome branch. It carries the fixed reason
`intermediate_outcome_null` and request/fence/attempt identity, no text. A later
fatal error carries that observed continuation reason in the existing restricted
runtimeFailure diagnostic (reset on request revision). Recovery does not invent
a reason for a branch not observed by the new attempt; previous internal events
remain the audit record.

PublicTextPublicationError now names its fixed stage/code. Existing safe failure
projection preserves this pair and allowlisted SQL/system classification from
the in-memory cause, never its message, query, token or arbitrary fields. These
fields remain inside runtimeFailure, which #491 already removes wholesale from
company-admin responses. No schema migration, new user-visible error or provider
retry is introduced. Actual internal model.failed protocolCode records remain
available; they are not reconstructed for the old production runs.

Two added Worker regressions:

1. First intermediate answer succeeds/seals, next native public output truncates,
   corrected replacement succeeds at the model but the controlled seal write is
   rejected. Ledger remains succeeded/failed/succeeded; run remains failed with
   no result. Restricted diagnostics report seal/persistence_rejected and the
   actual continuation reason. Public events contain neither diagnostic nor
   original cause. [Machine report](publication-failure-518.json).
2. A sealed explanation and one verified synthetic save precede exhausted
   protocol corrections. The save is not replayed; useful text is committed with
   truthful partial status. This is not a real visualize.save or browser check.

`npm run build` passed after these additions. Exactly the affected Worker,
writer, failure-diagnostic and model-execution suites were rerun: **42/42 pass,
zero skips**, 55.75 seconds; [full output](issue-518-focused.log). This includes
cross-tenant rejection, strict diagnostic revalidation, raw-secret exclusion,
nonretryable publication causes, cancellation, recovery and effect idempotency.
Earlier 136-case driver/Worker results apply to the unchanged protocol/driver
portion; they are not represented as a rerun of the final whole source.

These fixtures establish the controlled branch and preserve failure semantics,
not the historical publication cause, skill-activation delay, exact TTFT or
complete visualization acceptance. No browser or live-provider run was made;
the user's explicit no-browser instruction overrides those issue checkboxes.
