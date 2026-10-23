# Native work trace failure model

Recorded before implementation. All qualification inputs are synthetic.

- Python execution has real control-plane start/end events, but the public trace
  currently drops them. Preserve the step/call, request and fence identity, exact
  observed clock boundaries and explicit failure/timeout/cancellation status.
  The legacy `ipython.*` envelope also wraps direct tools: it must not create a
  second execution span for those calls. Rejected, never-started code is not an
  executed Python interval.
- Host actions invoked by candidate reconciliation or resource refresh bypass
  worker presentation hooks. Capture actual dispatch at the control plane after
  authorization and ledger replay checks, including live in-flight snapshots.
  A cached receipt must preserve the original interval even across a new fence.
  Actual parallel calls/retries retain distinct identities and actual intervals.
- Diagnostic capture must not change action identity, receipt reconciliation,
  model calls, usage or cost. Failure to durably record a pre-dispatch marker
  prevents dispatch; failure after an effect cannot overwrite its actual receipt.
  An interrupted marker stays unknown, without a fabricated terminal boundary.
- Native action traces are internal diagnostics, not recoverable tool output,
  public body text, progress facts or semantic-review evidence. Workers cannot
  forge this reserved step kind. Existing runtime hooks and native traces match
  by exact action identity, request and fence; labels alone never imply identity.
- A known Python parent requires a matching real step/request/fence. A model
  interval or previous cell is not an inferred parent. Trace metadata exposes
  only bounded safe names, IDs, states and measured timestamps; no Python code,
  arguments, raw results, error text, prompts or private reasoning.
- Live trace, terminal SSE and history must agree. Root/descendant authorization
  and reauthorization still apply. Old events without measured timing remain
  unknown; cancellation never turns an unobserved tool finish into success.

No schema, wire protocol or release identifier changes belong to this patch.
