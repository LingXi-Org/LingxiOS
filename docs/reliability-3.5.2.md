# Recovery follow-up for 3.5.2

Total model deadlines and durable root execution deadlines now keep distinct
model_unavailable / budget_limit terminal classifications. The issued call is
settled before the error escapes; caller cancellation retains its original
reason and does not start another attempt.

Semantic-memory embeddings now use the same allowlisted error metadata parser
and credential/provider/model circuit protection as chat requests. Rejections
including 429 insufficient_quota open the rejection circuit rather than being
retried by every new background work item. The vector-space cache identity still
excludes credentials, so rotating a credential does not mix or rebuild vectors.
Each embedding HTTP attempt stays single-shot; the shared model execution budget
owns bounded transient recovery. No fallback embedding space is introduced.

Regression tests first reproduced generic total-deadline errors and unclassified
embedding quota rejections, then passed after the repair. Additional admission
coverage settles near-limit priced usage twice under one call identity, verifies
one cost charge, denies startup plus closing capacity, and creates no child work.
These are controlled usage and pricing fixtures, not live provider billing.

Release gates remain mandatory: build/typecheck, the full package test set,
PostgreSQL stores, separate-process recovery, workspace/capacity and the confined
Linux image. Publication requires successful gates on the exact main commit and
the matching v3.5.2 tag. Schema12 is unchanged; no database migration is added.
No product deployment is part of this release.
