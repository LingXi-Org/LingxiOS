# Lazy trusted evolution benchmark registration

An integration that freezes a benchmark in `resolveScopes` couples every memory
read and conversation context load to the evolution registry. Registration belongs
to the authorized synthesis transaction that actually proposes candidates.

| Boundary | Required result | Focused regression |
| --- | --- | --- |
| Cold tenant, approved nonempty candidates | Freeze definition, synthesize memory, create inactive candidate/evaluation and action receipt atomically | Native executor with real PGlite schema |
| Existing ID with another definition | Hard error; no synthesis, evidence processing, candidate, evaluation or successful action receipt commits | Same transaction rollback |
| No candidates, rejected/processed/forgotten evidence, load or ordinary read/context | No benchmark registry query | SQL interception rejects any registry access |
| Current scope revoked or deleted | No registration or proposal; preserve authorization/epoch gates | Revoke and forget before apply |
| Benchmark option mutated after runtime creation | Use the captured trusted definition and ID | Mutate caller-owned nested cases/ID |
| Definition ID differs from benchmarkId | Configuration rejected before database work | Runtime construction |
| Legacy benchmarkId-only option | Existing pre-freeze requirement retained | Cold failure, explicit freeze, successful retry |
| Cancel or deadline during registry write | Same bounded action connection is discarded; unfinished transaction/receipt rolls back; next action can proceed | Instrumented connection plus existing deadline ownership tests |

No migration, model-visible benchmark arguments, authorization cache, process-wide
registry cache or detached background freeze is introduced. The public trusted
control API remains available. Live provider and production latency are outside
these deterministic tests.

## Qualification

The same 13 focused tests were run before implementation on
`b0d42467dfcb39f3069af658ef2547a8d1e5692b` (runtime 3.5.4): 7 passed and 6 failed
as expected. Failures covered cold registration, ignored frozen-definition
conflicts, mismatched IDs, caller mutation, and reaching the shared transaction's
freeze during cancellation/deadline tests. After implementation, all 13 passed.

On the 3.5.5 candidate, the following build and owning regression passed (50 tests,
including those 13), as did the separate standalone tarball installation test:

```sh
npm run build
node --test --test-concurrency=1 dist/test/memory*.test.js dist/test/evolution.test.js dist/test/optional-memory-context.test.js dist/test/semantic-memory.test.js dist/test/deadlines.test.js dist/test/tool-recovery-transaction.test.js
node --test dist/test/package-install.test.js
```

Environment: Node 22.23.3, Linux, PGlite 0.5.8. The cancellation fixture models a
discarded PostgreSQL connection by explicitly rolling back PGlite's embedded
connection; it asserts that the actual benchmark INSERT was reached, the same
connection was discarded once, no effect/receipt survived, and a later action
succeeded. It does not claim a live PostgreSQL socket cancellation measurement.
The release workflow still owns the exact-commit full release gates.
