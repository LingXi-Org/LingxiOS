# #216 legacy summary: portable independent red/green probes

This package contains synthetic, counts-only reproductions of the two legacy
summary triggers: the old `model.started.memorySnapshot` array format and removal
of a counts-format event by the actual `maintainStorage` expiry path.

| Case | Red e8 model count | Fixed e10 model count | Persisted summary count |
| --- | ---: | ---: | ---: |
| Retained counts event control | 0 | 0 | 1 |
| Old snapshot arrays, no memory action | 1 | 0 | 1 |
| Counts event expired by maintenance | 1 | 0 | 1 |

Every runtime case calls actual `createLingxiOS`, `AgentRuntime`, memory forget,
and an isolated in-memory PGlite fixture. The model is a local synthetic stub.
The historical summary/event shape is deliberately installed by the fixture;
this is not a claim that an old released binary generated it during these runs.
The expiry case deletes exactly one synthetic expired event. All cases finish
with zero memory rows, zero memory tool actions and one post-forget model call.
The probe also asserts that forget leaves the stored history/summary unchanged.

## Source identities and evidence

- Red: `e8f4942181802433b52d9d9e6ba946dd2d2f31a2`.
- Fixed: `e10bcd68afe000c5515eeafa93159513062fd1c8`.
- Fixed docs head: `a7ba3c92ae6966988b7be430dace2568ea4186c3`.
- Integrated candidate reported pushed by the parent:
  `b8bbef2762c782c75079c3f81113296e95d17bb1`.

`evidence/original-*` contains byte-identical historical count/source-proof
files. `PROVENANCE.json` records their hashes and the original, nonportable
scripts' hashes. The new scripts were actually executed separately; those
results belong only to `validation/` and `VALIDATION.json`. Do not attribute
the new CLI scripts to the historical runs.

The original red stage was independently compiled from the exact e8 archive.
The green stage reused its unchanged compiled modules and separately transpiled
the exact e10 `history.ts`; it was not another full build. This handoff reuses
those stages read-only, with no install or rebuild. The one production change
between those revisions is reproduced in `source/history-fix.patch`.

`source/revisions.json` binds the relevant source blobs. The candidate b8 has
the same history and memory fixture blobs as e10, checked locally. **b8 itself
was not executed by this portable handoff.** A caller-supplied
`--source-revision` is a label, not proof that a supplied runtime is that commit.
Verify the checkout/archive separately. Each execution records actual selected
input SHA-256 values in `execution-source.json`.

## Prerequisites

Use Node 22 (tested with 22.23.3; runtime declares >=22.13) and an already-built
source checkout/archive for each revision. It must contain:

- `dist/src`, `dist/test/memory-fixture.js`, `db/schema.sql`, `package.json`;
- the existing development dependency `@electric-sql/pglite` (0.5.8 in the tested
  source), resolvable from that runtime tree.

The published npm package alone is insufficient because it omits the test
fixture. These probes do not install packages, build a checkout, create a
network listener, connect to PostgreSQL/Redis, or use a provider credential.
Keep the source and build output for each revision together.

## Reproduction commands

Set these to your own **absolute** directories. `RESULTS` must be outside either
runtime tree. Each probe's output subdirectory must not already exist.

```sh
HANDOFF=/absolute/path/to/issue216-portable-handoff
RUNTIME_RED=/absolute/path/to/built-e8-source
RUNTIME_GREEN=/absolute/path/to/built-e10-source
RESULTS=/absolute/path/to/new-results
mkdir -m 700 "$RESULTS"

node "$HANDOFF/scripts/legacy-summary-probe.mjs" \
  --runtime-root "$RUNTIME_RED" \
  --source-revision e8f4942181802433b52d9d9e6ba946dd2d2f31a2 \
  --expect red --output-dir "$RESULTS/red"

node "$HANDOFF/scripts/legacy-summary-probe.mjs" \
  --runtime-root "$RUNTIME_GREEN" \
  --source-revision e10bcd68afe000c5515eeafa93159513062fd1c8 \
  --expect green --output-dir "$RESULTS/green"

node "$HANDOFF/scripts/projection-compatibility-probe.mjs" \
  --runtime-root "$RUNTIME_GREEN" \
  --source-revision e10bcd68afe000c5515eeafa93159513062fd1c8 \
  --output-dir "$RESULTS/compatibility"
```

`--expect red` exits zero only when it reproduces the two known leaking counts
of 1, with the counts-event control still 0. It does **not** mean the red source
is safe. `--expect green` requires all three model counts to be 0.
Assertions use the same scenario expectations as the original probes; they
have not been weakened. Generic failure output omits exception bodies/stacks.
Do not print model input or database rows when investigating a failed run.

To check a built b8 checkout later, use its root and full revision with
`--expect green`, and run the compatibility probe against that same root.
Use new output directories and retain that run as separate evidence.

## Approved compatibility boundary

When memory is enabled, legacy summaries without durable source proof are
withheld only from model projection. This may also withhold an ordinary legacy
summary whose provenance cannot be established; the parent explicitly approved
that tradeoff. Stored history/summary/ledger remain intact.

The compatibility probe checks available/empty-scope, unavailable-memory and
no-memory contexts. Legacy model counts must be `0 / 0 / 1`. Current authorized
original user messages, already public answers and explicitly clean
`memorySources: {version: 1, sources: []}` summaries must remain intact in all
three cases; original input objects must remain unchanged.

## Scope and release status

This is a bounded legacy regression handoff, not whole-issue or production
approval. Admission is indexed separately in `ADMISSION-INDEX.md`; it was not
rerun for this package. No real provider, real PostgreSQL concurrency, final
image startup, or sandboxed worker acceptance was tested here.

The parent reports image `535873b9` passed Web startup, migration and 997 static
checks, but **Worker failed with a bubblewrap permission error, exit 1**.
Worker acceptance remains failed. Do not bypass isolation or infer Worker
success from these PGlite results.
