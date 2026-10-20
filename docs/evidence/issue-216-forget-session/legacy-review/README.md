# Legacy provenance follow-up

Baseline: `e8f4942181802433b52d9d9e6ba946dd2d2f31a2`. Owning failure tests were committed before the implementation in `b787d0f`. Fixed source: `e10bcd68afe000c5515eeafa93159513062fd1c8`.

Independent review found that the old summary detector understood only newer diagnostic counts, while formal 3.5.6 stored memory snapshot arrays. Actual `maintainStorage` also expires model trace events while leaving session summaries. The missing event therefore cannot establish that an old summary is clean. The original array and expiry failures remain in this directory, alongside the separate compatibility red test.

The correction changes one predicate in `invalidMemorySources`: when a memory snapshot is present, a summary without durable provenance is withheld only from model input. It does not read, delete or rewrite the stored summary, original history or business receipts. It does not refresh an old epoch, add a migration or call a model to rebuild history.

This intentionally also withholds possibly ordinary details in an unproven legacy summary. The release owner approved that compatibility tradeoff. Explicit `sources: []` summaries, ordinary tools, current authorized original messages and already-public answers remain available; without memory, the old summary behavior remains unchanged.

| Owning check | Before correction | Fixed source |
| --- | --- | --- |
| Old `core`, `directory`, `recalled`, `strategies` snapshot arrays | 4 failed; counts control passed | 4 passed |
| Counts event expired by actual `maintainStorage` | 1 failed | passed |
| No evidence / empty current scopes / unavailable memory; clean/no-memory controls | 1 failed | passed |
| Existing history, metadata and two-process receipt/summary recovery | prior 9 passed | 9 passed |

`fixed-green.txt` contains 15 tests total, all passed in 25.59 seconds. `fixed-build.txt` is the successful normal TypeScript build. The actual runtime tests use synthetic inputs and PGlite, not a live provider or network PostgreSQL. Historical snapshots are explicitly installed fixtures, not outputs claimed to come from an old runtime binary. The fixed-source test command was:

```sh
node --test --test-concurrency=1 dist/test/memory-history-projection.test.js dist/test/memory-legacy-snapshot.test.js dist/test/memory-session-forget.test.js
```

The processes exited normally. Each test stops its own runtime and closes PGlite in `finally`; the subprocess tests remove only their own temporary databases. `fixture-cleanup.json` records the post-run absence of these test-directory prefixes. Evidence directories remain. No production fixture, shared database, dependency target or paused soak was touched. Independent review and the release owner's combined CI/package/product gates remain separate.
