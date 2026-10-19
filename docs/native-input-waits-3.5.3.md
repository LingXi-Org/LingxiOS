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
