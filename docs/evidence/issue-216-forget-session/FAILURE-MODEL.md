# Forgetting and durable model context

Written before the correction, on `3628e9e7f0fee8c3ee0550789a4fc21b3681dd14`. The relevant runtime, session store, compaction and forgetting source files are identical to base `627e6627`; `baseline-source-proof.json` records that comparison. Existing memory governance tests check deleted documents/searchable evidence and stale capture; they do not cover persistent model history.

The red reproduction uses actual `createLingxiOS`, `AgentRuntime`, native `memory.read` and file-backed PGlite. The synthetic marker exists only in a reference memory document. `optionalRecall: true` makes the initial model input marker-free. User requests and every committed final answer are marker-free. A first native read returns the marker and persists its real tool output.

After the public memory API forgets the scope, memory rows are zero and reading the document returns null. Nevertheless:

1. The next run in the same session sends the old tool output to the model.
2. A later run sends it to actual runtime compaction, which stores a derived summary.
3. After closing the application and database, a second Node process opens the same PGlite directory and sends the persisted summary to the model.

Both processes finish successfully. Count-only receipts are `baseline-seed-counts.json` and `baseline-restart-counts.json`; provider input marker counts are 1 at each affected boundary. The first model input, dynamic-memory items, original user requests and committed final answers have count 0. No external provider or production connection was used. The low compaction threshold is a controlled fixture setting, not a production performance measurement. Preliminary fixture attempts used default automatic recall or an invalid 4000-character tool range; these were setup failures, not the recorded semantic red.

## Required invariants

- Persist trusted source scope/epoch information with memory-derived model context. A later scope epoch or revoked scope invalidates that context before model or compaction input, including restart.
- Keep original action receipts for idempotency/recovery. Do not rewrite user messages, public final answers or the entire session to erase a marker.
- Preserve currently authorized memory observations and ordinary tool continuity.
- Derived summaries must carry their dependency on memory sources; unproven legacy summaries must not silently bypass forgetting.
- Current model-attempt admission remains authoritative for concurrent forgetting. This correction must not refresh or override another attempt's `work.meta.memoryAdmission`.
- Cover the same source-only marker after a new run and a real process restart, plus legitimate user/public-answer and ordinary-tool positive controls. Record unsupported or untested boundaries explicitly.

Implementation is isolated from the concurrent model-admission change. Prefer existing durable JSON storage; a new migration requires coordination with the release owner.
