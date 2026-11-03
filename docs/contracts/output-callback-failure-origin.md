# Local output failure attribution

An output callback can reject a model response even when the provider returned a
normal native call. For example, the actual answer-source validator rejects a
replacement that names no active source. When usage was available, the stream
wrapper previously labelled this ordinary local exception `provider/unknown`.
That label did not establish a supplier failure.

This classification candidate adds the closed diagnostic kind `output` and the
optional `outputCallback` value `operation` or `delta`. Each driver invocation
tracks callback exceptions in its own WeakMap without mutating the exception.
The existing stream wrapper attaches attribution only when it would already
wrap the error. Existing publication errors also use the `output` kind.
The public model projection allowlists these values, and the existing model
failure settlement can carry the same closed attribution into its ledger.
No source IDs, response text, error messages, stack traces or arbitrary error
properties are included in these new fields.

Origin is separate from recovery category. Categories, retry eligibility,
protocol-correction conditions, cancellation, terminal handling and billable
usage remain unchanged. A callback-thrown protocol error retains `protocol`;
the change does not convert an invalid replacement into a correctable protocol
turn. An unmeasured ordinary exception retains its original identity, as before,
and does not gain model diagnostics. Non-object thrown values likewise retain
the existing handling. These limits preserve control flow rather than guessing
an origin from an error message or stack.

Synthetic tests exercise the real answer-source validator through the native
driver, measured settlement, sync/async callbacks, final native identity
validation, concurrent reuse of an error object, protocol/network/timeout
classification, typed lifecycle errors and diagnostic privacy. No live model
request is needed. This proves an SDK attribution defect for the synthetic
case; it does not identify the cause of historical product failures.
