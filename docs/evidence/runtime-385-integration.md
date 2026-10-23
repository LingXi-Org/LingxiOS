# Runtime 3.8.5 integration

This release combines native execution tracing and explicit same-generation
public outcomes. Ordinary replies keep the direct model/tools loop. The optional
purpose-json-v2 producer streams the answer before bounded terminal outcome
metadata; partial and blocked declarations do not trigger a semantic judge or
automatic rewrite. Native authorization, cancellation, pending-effect receipts,
artifact checks and budgets remain authoritative.

Native host actions and Python lifecycle events gain actual captured execution
intervals. Cached effect receipts retain the original interval, retries retain
their distinct execution identities, and diagnostic records stay out of model
context. Missing historical times are not inferred. Non-model spans do not add
model usage or costs.

Integrated feature commits:

- Native tracing: `a8c33f3fea163dd1d1ee43506b404876a2c54c5b` (PR53).
- Same-generation outcomes: `ce343d309177b16e1160c3f9bca35c7c9ddb189c` (PR54).

Both features have independent source review. The combined local build and 120
owning tests passed, with zero failures and skips. This covers parser and Worker
SSE, terminal declarations, native effect precedence, custom-driver bindings,
protocol recovery, candidate completion, host dispatch, cached recovery,
parallel/retry identity and Python lifecycle tracing. These are synthetic local
checks, not external-provider or production performance measurements.

Only the package manifest, lock root versions and releaseVersions.runtime advance
to 3.8.5. Native schema14, control-plane11, public-text reader2 and run-trace1 are
unchanged; no DDL or schema migration is introduced. V1 producer behavior and its
provider fingerprint remain compatible. A deployment must still respect runtime
bindings and checkpoints; this release does not authorize reinterpretation of
unfinished work bound to an older runtime or producer.

Exact release CI, formal registry publication and downstream qualification remain
separate gates. This source document does not claim those operations occurred.
