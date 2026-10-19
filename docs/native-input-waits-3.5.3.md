# Native input waits in 3.5.3

Native product tools can now request a durable user-input wait with the public
`userInputWait(question, value?)` result helper. Existing successful
`defer/user` result directives remain compatible. The runtime uses the question
in the receipt, so a product tool may accept a structured form rather than a
`question` argument. Sending a card and returning ordinary success alone still
does not request a wait.

Both memory and PostgreSQL ledgers require an intent and successful receipt for
the same work and request version. Failed, unknown, rejected, non-user, malformed,
missing and stale receipts cannot authorize an input wait. Approval validation
retains its existing separate contract.

Recovery reconstructs the latest model tool batch from durable receipts and parks
before another model call or tool execution. This covers a lost action response
and a saved function output before the work enters waiting. When an input wait
ends a tool batch, unstarted later calls receive `not_started` outputs. A human
reply starts a fresh turn instead of running those calls with pre-input arguments.
Child and approval continuation semantics are unchanged.

The product remains responsible for card identity, schema and answer validation,
authorization and submission deduplication. It resumes the original run with
`continueInput` and the authenticated identity, input ID and waiting request
version. No vendored runtime, product wait bypass, schema change or migration is
required.

Regression coverage includes memory/PostgreSQL receipt parity, builtin and native
Python waits, direct-tool receipt replay, same-batch downstream call suppression,
and real PostgreSQL workers killed after the receipt commit or before waiting.
The worker regression checks one card, no replacement model call, and a fresh turn
after a human reply.

This is a release candidate, not evidence of publication. Publication still
requires the repository release gates on the exact main commit and matching
`v3.5.3` tag: full tests, PostgreSQL stores, worker recovery, workspace/capacity and
the confined Linux worker image. Product integration must pin the actually
published `@lyyzka/lingxios@3.5.3`; a local candidate archive is test input only.

### Read concurrency and terminal wait contract

Only **non-read** tools may return a terminal `defer` directive, including
`userInputWait()`. This supports `transaction`, `idempotent`, and `uncertain`
tools; existing product `chat.ask` tools using `effect: 'uncertain'` remain valid.
Creating a question/card is an effect, so it must not be declared as a read.
The `deferred` catalog flag controls schema discovery and does not mean waiting.

Read tools retain bounded four-way concurrency. If a read returns any terminal
`defer` (user, child, or other reason), the control plane records
`read_wait_contract` with `executionState: 'unknown'`, preserves the complete
original return in `value.rejectedResult`, and removes the wait directive before
it can authorize waiting. It does not claim the action had no effects, undo an
already-created card, or promote the invalid return through native reconciliation.
The host must reconcile any actual effects before continuing writes.

The runtime also rejects terminal waits returned by custom read HostPorts.
Already-started peers finish and retain their real outputs exactly once; they
are never marked `not_started`, and the invalid wait does not park the work.
Valid non-read input waits execute serially and close only unstarted siblings.

Recovery limits apply to each cell independently: at most 100 action receipts
per cell, with a bounded 101-row overflow probe per cell. Recovery examines every
cell in model order, including waits beyond the first 100 combined receipts.
A receipt after a terminal wait remains a reconciliation conflict, including
when it belongs to a later cell. Missing receipts and non-contiguous indices
remain ineligible for terminal recovery.

Recovery also rechecks the current registered effect before accepting a
historical terminal wait. Read tools and removed/unknown tools block for
reconciliation; non-read tools remain eligible under the existing receipt and
request/fence validation. Custom HostPort step/cell recovery enforces the same
read-wait rejection before parking.
