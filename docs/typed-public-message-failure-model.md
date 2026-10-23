# Typed public message continuation

Opt-in `publicTextContinuation: 'typed-message-v1'` permits a complete v3 message
with explicit operation, substantive nonempty answer, null outcome, no tools,
and normal finish to seal as an intermediate item. It does not declare a final
outcome. Native business schemas and argument bytes remain unchanged. A simple
terminal answer remains one generation; no preface stage is scheduled.

Failure matrix written before implementation:
- Opt-out/v1/v2 retain terminal-outcome rejection and their fingerprints.
- Missing/empty/null answer, prose, malformed operation, bad finish and incomplete
  output never become intermediate messages. Tool batches retain whole-batch validation.
- Capability and result phase must agree. Custom drivers cannot infer intermediate
  from absent outcome. Envelope transport and continuation cannot be combined.
- Normal generation budgets count every intermediate item. No correction budget
  reset, extra retry, auxiliary judge, or artificial low call limit is introduced.
- Cancellation and publication permission are checked before seal and next action.
- Intermediate seal cannot mark a run accepted/completed or bypass final delivery,
  citation, resource and obligation checks. Explicit final/partial declarations
  continue through existing validation, including a null final body with sealed sources.
- A → tool → B → final preserves exact source text and identity, including explicit
  replacement. No-op empty output is invalid; equal text under distinct IDs is not
  silently deduplicated.
- Crash after durable seal but before history save must restore the sealed body in
  current-work history once, without resealing or fabricating tool outputs. Memory
  provenance must survive this window so revocation projection still applies.
- Single-attempt, budget/quota and fallback wrappers preserve the capability;
  private v2 selection removes it and changes the actual binding accordingly.

Reuse: existing PublicPurposeParser, v3 publication/seal transaction, checkpoint
steps and AnswerSegmentSet remain authoritative. The latter directly uses the
pinned LangGraph reducer and LangChain messages listed in react-harness-reuse.md.
Codex design reference is commit 398500106707f0a3217c7cf83edc2bf226cc342f,
protocol/models.rs MessagePhase and codex-api SSE tests for partial_answer with
end_turn=false: message completion is distinct from turn completion. No Rust code
is imported and no provider support is inferred from that reference.

## Implemented boundary and evidence

The capability is explicit in OpenAIDriverOptions and ModelDriver; a completed
nonterminal result has publicTextPhase='intermediate'. Opt-out fingerprints and
v1/v2 behavior retain the old representation. Envelope transport is incompatible.
Single-attempt and execution/quota wrappers preserve the capability; fallback
selection requires equality. Private work removes it when selecting v2.

Recovery metadata travels in a host-only RunEvent.publicTextRecovery field, outside
strict public event data. The existing authorized seal transaction stores it in
runtime.answer_segment.output. PostgreSQL event columns, the memory event store
and immediate delivery fan-out exclude that field. Its memory dependencies are
restored with the body and subjected to the existing live memory projection.
The request_snapshot JSON stores publicTextHistory (revision and part IDs) in the
same session transaction as history. This cursor survives compaction; delegation
strips the parent cursor. No DDL or second checkpointer was introduced.

Offline evidence (all synthetic, zero provider requests):
- /workspace/typed-message-red.log: missing driver continuation/phase before fix.
- /workspace/typed-message-runtime-red.log: real Worker initially rejects the
  valid intermediate A → tool → B → null-final sequence.
- /workspace/typed-message-focused.log: 41/42 passing. The one fast-only fixture
  failed before its intended recovery assertion because its forced fast profile
  and later throwing deep fake did not represent the normal routing policy.
- /workspace/typed-message-fast-red.log: corrected fixture uses real auto routing,
  fast intermediate → restart → terminal-only deep. With deep-only restoration,
  resumed request contains zero copies of the already sealed body (expected one).
- /workspace/typed-message-final-boundaries.log: final 4/4 pass, including the
  repaired fast recovery, delegated cursor removal, exact wire instruction token
  accounting/native schema preservation, and fallback capability mismatch.
  Combined with the 41 unaffected passing cases this closes the 42-case focused
  matrix; the final check also exercises two additional delta tests. It is not a
  claim that the complete repository suite was rerun after the fixture correction.
- Final build succeeds and git diff --check passes. Prior failed logs are retained.

Worker coverage includes original terminal arithmetic in one generation, A →
tool → B → null final, first-seal lost ACK, later-seal lost ACK after an already
executed tool (one execution total), cancellation, permission gates, malformed
batches, explicit partial outcome, unchanged global budget exhaustion, and private
v2 binding. Unit coverage includes incomplete/empty/noop rejection, memory
revocation projection, compaction cursor retention and no public provenance leak.

Limits: these tests establish lifecycle and recovery behavior, not the real
provider's choice to emit useful early text. No forced introductory model call,
extra retry or increased budget is added. Final resource/delivery verification
still runs only on explicit terminal declarations. Real graph/arithmetic and
browser qualification remain the integrator's responsibility on the frozen build.
