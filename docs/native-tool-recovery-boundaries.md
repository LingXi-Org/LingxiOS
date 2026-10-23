# Native identity fragments and correction contract

The formal 3.8.10 product fixtures failed. Their saved safe wire observations
contain only argument lengths and structural metadata for the rejected native
prefixes, not their raw argument bytes or per-frame name fragments. Therefore
the 88/9-character native prefixes cannot establish which envelope member or
identity check rejected the live turn. No provider call was repeated to fill
this gap, and the earlier one-tool development probe is not full-catalog proof.

Two independent defects are reproducible from source and synthetic input:

- A tool-name fragment arriving with nonempty arguments was required to match
  an entire catalog name immediately. The old driver rejects two otherwise
  valid interleaved streams before any public output. Arguments now remain in
  the existing accumulator, bounded to 16 MiB, until a catalog identity is
  available. Then the exact accumulated bytes feed the existing parser once.
  An already bound identity cannot change, including a short catalog name that
  is a prefix of another name. Unknown or incomplete identities never publish.
- Protocol correction copied the generic public-purpose schema into a user
  message even when the driver selected the native envelope. Correction now
  references the driver's actual contract instead of copying a second schema.
  The envelope instructions explicitly distinguish tool-null outcome from the
  required terminal outcome object. Terminal outcome:null remains invalid.

The actual arithmetic failure also answered the earlier graph task despite a
correct current request snapshot. The correction now explicitly targets current
trust=request blocks and revisions, with a source/version/revision identity
anchor derived from the current session request at model-input construction.
Historical requests remain observations; no history or result is removed.
The anchor participates in the existing input estimate and admission path.

Before/after synthetic regressions cover interleaved identity, identity-only
completion, preserved raw arguments, unresolved identity, cancellation, late
identity changes, plain companions, no-tool terminal null rejection, and actual
Worker correction payloads. A same-session Worker fixture completes an earlier
Gather/Check request before the current arithmetic request and verifies the
actual correction payload retains the old observation and anchors the current
request. This checks payload authority, not a guarantee of model semantics.

The buffered identity policy has a new fingerprint only when the envelope is
enabled; opt-out retains the exact 3.8.10 fingerprint. Existing source reuse
remains unchanged: pinned @streamparser/json 0.0.26 owns JSON grammar and the
existing PublicPurposeParser owns typed public content. No additional model
turn, judge, speculative tool execution or automatic unknown-effect replay is
introduced. Full development graph-to-arithmetic qualification is still required
before release; these fixes do not claim to diagnose the uncaptured live prefix.

Offline result: build and 145/145 focused tests passed (zero failures/skips):
native-tool-public-output parser/driver/Worker, protocol-recovery driver/Worker,
native-tool-companion and react-wire-boundaries. Version 3.8.11 is an unpublished
development candidate; version metadata alone does not confer qualification.
