# Existing admission evidence index — no new admission execution

This is only an index to the separate admission review. This package neither
copies its database environment nor reruns its concurrency probes.

- Red source: `cb6f7f672216d57f40def58a6312c4827e5f4b69`.
- Fixed source: `a942671cb5915a80946e1982de4fda49f9e6de5e`.
- Evidence head: `bbbac002c9f2c7aadee55aa29e0c703faff5b953`.

The existing independent fixed-source review reports closure of four bounded
P2 findings: actual final clock/lease expiry, server-bound request version,
typed pre-provider deadline errors, and settlement serialization through final
admission commit. Its original four boundary tests changed from 1 pass / 3 fail
to 4 pass; the separate real PostgreSQL settlement race changed from red to
green. These are that review's results, not executions performed by the legacy
handoff. Full source identity and report hashes are in
`source/admission-index.json`.

Committed owning tests and evidence:

- `test/memory-admission-review.test.ts`
- `test/memory-context-budget.test.ts`
- `docs/evidence/issue-216-continuity-fixes/review-followup/README.md`
- `docs/evidence/issue-216-continuity-fixes/review-followup/author-red.txt`
- `docs/evidence/issue-216-continuity-fixes/review-followup/final-green.txt`
- `docs/evidence/issue-216-continuity-fixes/review-followup/settlement-red.json`
- `docs/evidence/issue-216-continuity-fixes/review-followup/settlement-green.json`

Read those paths at the evidence head above. Any new real concurrency
reproduction requires its own isolated database and a separate authorized run;
the local PGlite legacy fixture does not establish concurrent PostgreSQL
locking behavior. Final combined source, publication/cancellation ordering,
and Worker isolation remain independent release gates.
