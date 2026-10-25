# Internal runtime failure diagnostics

Workers persist a bounded `runtime.failure` event immediately before the normal
terminal failure handling. Its visibility is always `internal`; `run.failed`,
terminal errors and ordinary `readEvents` retain their existing public behavior.
No database migration is required.

Configure an optional immutable deployment identity when creating the Worker:

```ts
createWorker({
  // Other production Worker options remain required.
  deploymentVersion: '0123456789abcdef0123456789abcdef01234567',
  // ...
})
```

`deploymentVersion` accepts `unknown` or a complete 40/64-digit hexadecimal Git
SHA. Invalid configuration fails at construction. The runtime reads no
product-specific environment variables. The diagnostic also records the native
runtime version and an allowlisted UUID `correlationId` from the existing failure
classifier.

The trusted server API `app.readDiagnostics(identity)` adds
`runtimeFailure: RuntimeFailureDiagnostic | null`. It returns the latest valid
internal diagnostic for the run's **current request version and fence**. Earlier
attempts and requests are excluded. Applications must authorize this operator
API separately from ordinary conversation access; it is not a user-event API.
The diagnostic types are exported from `@lyyzka/lingxios`.

`phase` identifies the runtime operation in progress. Before a first binding is
saved, the relevant phases are `execution_snapshot`, `session_restore`,
`request_refresh`, `binding_prepare` and `binding_save`. Later execution uses
`session_save` or `turn_execution`. Context, recovery and processor failures have
their own phases. `bindingState` distinguishes `unknown`, `not_started`,
`saving`, `saved` and `restored`. In particular, `binding_save` / `saving` means
the Worker was awaiting the save: an acknowledgement may have been lost after
the server committed, so operators must inspect the durable steps before
inferring whether that save took effect.

Only fixed exception names, the existing official failure classification and
cause-code allowlist, SQLSTATE classes, numeric HTTP statuses, fixed system
codes and at most four fixed native source frames are retained. Frames contain
only a native module plus line/column. Native `dist/src` and its corresponding
source-mapped package `src` root are accepted only when derived from the loaded
module's own location. Arbitrary paths, function names, source lines, original
messages, raw stacks, queries, provider payloads and nested exception objects
are never copied. Worker input is validated before persistence and stored data
is validated again before operator reads.

Diagnostic writes are best effort. A write or logging failure cannot replace the
original terminal outcome. Cancellation, preemption, shutdown yielding and
lost-lease behavior are unchanged and do not produce a new terminal-failure
diagnostic.
