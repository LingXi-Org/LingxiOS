# Conditional explanation before authoring: independent failure model

This is an optional, request-bound ordering declaration made during an existing
skill activation. It is not a natural-language classifier, semantic proof,
permission grant, mandatory preamble, new judge, or general low call limit.
The human-approved qualification permits activation before useful explanation
when the selected workflow declares this conditional stage; ordinary arithmetic
still needs only its normal single terminal generation. Earlier real-model
failures remain failed records.

## Required boundaries

- No stage declaration, reference-only `skills.load`, a diagram-only task, or a
  task needing unavailable facts retains the existing unrestricted-by-stage
  loop. Tests supply or omit explicit declarations; they must not implement a
  keyword-based intent detector or pretend fixed fixture facts prove semantics.
- The trusted skill declares the supported workflow and authoring actions.
  Activation arguments bind to the current run, current request version, exact
  request/evidence source identity, source hash and quoted range. A declaration
  proves its references exist, not that its interpretation is correct.
- Repeating the same activation is idempotent. Omitting or changing its stage
  cannot downgrade a committed declaration. A foreign/stale source, malformed
  range/hash, revision mismatch or cancelled run is rejected without effects.
- The model receives the same authoring availability that actual dispatch
  enforces. Necessary reads and selected-skill guidance remain accessible.
  Hiding a catalog entry alone cannot authorize or prevent a direct action.
- Only a valid, current, explicitly stage-associated typed answer sealed after
  activation can provide the stage. An old source, provisional/truncated text,
  unrelated stage, commentary/progress, or another run cannot unlock authoring.
  The stage is recorded as provided, never as semantically verified.
- Stage progress is derived from existing durable activation/answer records.
  Losing a transaction acknowledgement and restarting must not repeat native
  output or an already known/unknown business effect. Cancellation at every
  checked boundary prevents further work. Replacement cannot silently delete
  the explanation while retaining its authoring permission.
- Candidate assembly, real resource/readback/delivery checks, native argument
  schemas, capability authorization and global execution budgets remain active.
  A stage receipt or model declaration cannot turn partial/blocked into success.

## Test method

Use real `OpenAIChatDriver`, `createWorker`, the current PGlite schema, actual
skill activation actions and real sealed events/steps. Script local provider
frames and inspect actual serialized requests and action results. The test may
supply different synthetic source texts and exact spans, but must not implement
its own semantic validator or production-stage reducer. Direct action tests
exercise the same gate as the advertised catalog. The base `de3da044` compiled
runtime supplies the pre-implementation red; compilation/startup failures are
kept separate from behavioral evidence. No external provider, production
conversation or production database is touched.

Quote matching deliberately accepts a model declaration whose words appear in
a quotation or negated sentence: the match proves origin only. Without an
explicit declaration those words cause no stage. Real content qualification must
still reject an incorrect interpretation. The suite does not assert verbose
prompt prohibitions; concise driver-owned protocol and actual execution gates
are the contract.

The stage is immutable only within its request version and its selected skill.
An independent skill keeps its normal activation path. A new authenticated
human revision may use the default loop or declare a new stage; neither the old
restriction nor its provided status is inherited. This boundary follows the
host request version, without interpreting withdrawal keywords.

The implementation calls `RunnableBranch.from` from `@langchain/core@1.3.0`
(upstream commit `38eb4d8f08b13a36b7d79c976bbdc56e250d87de`, `libs/langchain-core/src/runnables/branch.ts`) for deterministic tool-catalog routing.
That combinator adds zero model calls and no execution loop or checkpointer.
The existing LangGraph ID reducer, AIMessageChunk and tool conversion remain in
use. Native request/stage receipts, source binding, authorization, cancellation
and the action ledger retain durable execution responsibility. Quoted sentences
are provenance data rather than semantic proof.

## Executed evidence

The initial de3 compiled baseline produced 9 passes and 5 failures in the first
14 cases. A separate four-case baseline produced one pass and three failures;
old unassociated text and replacement both left authoring exposed. The first
implementation then exposed a real prompt-manifest mismatch after activation.
A local diagnostic observer identified it without changing runtime source or
weakening the guard. Stage context now uses the existing dynamic observation
path. Reusing one synthetic provider key also let deliberate failures open its
shared circuit; independent fixture keys isolate those tests while retaining
the circuit breaker within each run and restart.

The final stage/source run is **25/25** (`public-answer-stage-second.log`).
The missing-binding capability case passed in the first capability run; its
other three cases stopped in fixture setup because incomplete bindings were
correctly rejected. Those fixtures now use full runtime fields and actual
configured driver fingerprints through the unchanged native `saveStep` API.
The three corrected capability cases plus unknown-effect ledger recovery passed
**4/4** (`public-answer-stage-final-delta.log`). Thus **30 distinct new cases**
are covered across those runs, not a claimed single 30-case run. The capability
cases and final review-driven additions were added after their implementation;
they are regression checks, not retroactively claimed baseline failures.

The unknown-effect case reads the same action identity twice from the ledger,
observes exactly one business execution, and then cancels via the native API.
It retains the unknown receipt and produces no completed delivery. The private
capability case uses a native graph child, not a forged public-work flag.

This first stage version supports one explicit explanation stage per current
request. Another ordinary skill may activate independently; a competing second
stage is rejected without replacing the first. No real-provider content,
browser timing, final semantic acceptance, package release or deployment is
established by these local results.
