# Packaged runtime

## Ownership

`createLingxiOS()` owns the control plane: durable ingress, reads, cancellation, revisions, input continuation, approvals, reconciliation, diagnostics, delivery retries, memory administration, and Worker connections. It requires a PostgreSQL-compatible pool and does not claim work.

`createWorker()` from `@lyyzka/lingxios/worker` owns execution. It receives a local or HTTP control-plane connection, a model driver or provider configuration, Kernel configuration, runtime policy, product processors, and an optional evolution evaluator. Multiple Workers coordinate through leases and fencing.

The consuming product owns authentication, authorization policy, native services, its business schema, transactions, delivery transport, and model-cost ledger. It registers tools through public contracts; LingxiOS has no product-specific export or table access.

## Installation and versions

`packageResources()` returns the schema-11 fresh-install schema and explicit incremental migrations. Existing schema 9 applies `migration010`, then `migration011`, `migration012`, and `migration013`; schema 10 applies the last three (011/012 are idempotent). Migration 013 adds the step checkpoint and current session manifest and advances schema to 11. Fresh installations use only `schema`. The product owns the migration transaction; startup performs read-only checks and never executes DDL.

All public entries use runtime `3.3.4`, schema `11`, control-plane protocol `11`, Kernel protocol `2`, and assistant message `2`. Protocol 11 adds fenced binary workspace transfer and atomic step/manifest commits. Drain old Workers and upgrade hosts and Workers together; older claims are rejected. Existing runtime/Harness bindings must be drained or handled by their matching deployment, never rewritten merely to pass compatibility checks. Committed citation excerpts remain unchanged.

The built-in OpenAI-compatible driver streams assistant content as `user-text`, including literal JSON requested by the user. Reasoning and tool arguments are separate provider fields; content review remains an independent call before durable commit. Only custom drivers explicitly declaring `candidate-json` use candidate-body extraction. Version 3.3.4 changes neither the SSE wire format nor the database schema.

Before upgrading, stop ingress, drain running tasks, stop old Workers, and resolve unknown effects and pending approvals. Back up the database and artifact volume and retain the matching old application. Under the product migration lock, run `migration010` against schema 9. It refuses live leases, adds collaboration tables and nullable context/receipt columns, and preserves memory, tasks, results, action ledgers, approvals and product tables. Legacy records are not inferred to be IM conversations. Apply `migration011`, `migration012`, then `migration013`, deploy matching v3.3.0 hosts and Workers without mixed-protocol execution, run readiness checks, then resume ingress. Do not apply the fresh schema to an existing database. Schema-8 installations must first apply `memoryReset009`, which explicitly deletes legacy memory; this older reset is not part of the schema-9 upgrade.

For rollback, stop ingress and Workers again. Restore the matching old application, database and artifact backup together after reconciling effects committed outside PostgreSQL since the backup. There is no automatic down migration or conversion of new IM records. Existing Harness profile and approval bindings still apply; never fabricate a new hash for an old approval or replay an unknown effect. See [IM collaboration](im-collaboration.md) for authenticated ingress and transport contracts.

The package exports only:

- `@lyyzka/lingxios`: control plane, schema resources, tools, state, diagnostics, memory and evolution contracts
- `@lyyzka/lingxios/worker`: Worker factory, model and Kernel ports, product processor contracts
- `@lyyzka/lingxios/ui`: browser-safe committed-message and replay reducers
- `@lyyzka/lingxios/eval`: verification and evaluation helpers

## Execution contract

An authenticated request stores its original text, principal, tenant, Agent, conversation, optional thread, attachments, and later revisions. A Worker lease restores the session and request snapshot before any model or tool call. Session ownership and work fencing prevent stale Workers from committing.

Direct tools and Python `host.*` calls use the same action executor. Input parsing and authorization happen before intent persistence. Transactional native tools commit the business write and receipt together. Idempotent external calls carry the durable action ID. An unknown effect is not retried until its tool-specific reconciler resolves it.

`mode: 'execute'` permits authorized tools. Set `deliveryMode: 'auto'` for conversations that may need either an answer or an action; content and effect verification still apply, but a text answer does not require a business write. Use `deliveryMode: 'action'` when a successful business receipt is mandatory. Omitting delivery mode preserves the legacy execution receipt requirement.

`decideApproval()` binds a decision to the original identity, action arguments, request version, resource snapshot, and approval version. Continuation rechecks current authorization. `continueInput()` accepts only a committed response from the original principal and current waiting version.

Model calls reserve a durable root budget before provider access and settle tokens plus a frozen price/cost snapshot afterward. Missing provider usage is recorded as estimated, never zero. The model, tool, database, delivery, and shutdown paths receive bounded deadlines and cancellation signals.

## Outcomes and delivery

For ordinary (non-IM) jobs, `readMessage`, `readOutcome`, `readEvents`, `readUsage` and `readDelivery` require the original run, tenant, Agent, session, principal and optional thread. Wrong or omitted principal/thread fields return `null` (an empty page for events); an omitted thread matches only an unthreaded job. Hosts must pass the authenticated identity on every read, including reads of completed jobs. IM content retains its frozen-audience authorization: another currently authorized audience member may read shared results with the exact thread, while internal results remain restricted to the original principal.

The work status is `queued`, `leased`, `waiting`, `succeeded`, `partial`, `blocked`, `failed`, or `cancelled`. Goal status and delivery status are independent. `readRunState()` uses one database snapshot to return the current run, authoritative committed message, and delivery state.

Simple text can finish without a synthetic self-assessment object. Resource-producing work is checked against current action receipts, native readback, and committed artifact bytes. Unknown effects, missing requested artifacts, and failed checks prevent a satisfied outcome. Content review is bounded and keeps verified work between correction attempts.

Missing results blocked by an explicit human-request constraint remain partial, but do not trigger futile content corrections. The review must ground the blocker in the human request; candidate claims, attachment content and agent revisions cannot establish it. Repairable omissions still use the normal correction budget.

Result, event, and model-ledger outboxes use expiring claims, bounded retries, exponential backoff, stored errors, terminal failure markers, and trusted retry APIs. A stalled native transport cannot block other channels or Worker scheduling.

## Distributed previews and files

A product may pass `realtime.store: RealtimeStore` to share ephemeral drafts across control planes. Implement atomic owner/fence/requestVersion/attemptId/seq checks, 60-second expiry, conditional clear and subscribe-before-read. Notifications are wake hints; readers also poll snapshots and always reauthorize. A cache failure resets the draft while durable PostgreSQL replay continues. Without a store previews remain local to the control process. Hosts bound cache operations to 250ms and browser streams to one queued frame.

Pass `objects: RuntimeObjectStore` for private shared artifact bytes, and `workspace: {}` to enable file checkpoints. The product owns credentials and its object adapter; use immutable keys and private, consistent reads. Every completed Python cell freezes its Linux process tree, captures regular files/directories, uploads changed hashes with concurrency two, then commits the step and manifest in one fenced PostgreSQL transaction. Failures cannot mark the step complete. Interrupted cells restore the last committed directory before continuing; unknown external effects still require reconciliation. Recovery verifies size, hash and paths in a sibling directory before activation. Interpreter memory, open handles and `/tmp` are not checkpointed.

Defaults: 4096 entries, 128 MiB total, 32 MiB per file, 60 seconds per capture/restore. `workspace` accepts bounded overrides up to 4096 entries, 1 GiB total, 64 MiB per file and 300 seconds. Links and special files are rejected. Maintenance examines at most 100 objects per pass; it retains current references and active-attempt uploads and removes unreferenced objects older than 24 hours.

Before enabling shared files, stop ingress and Workers, back up the database and **each control plane's committed-artifact directory plus each Worker's homes volume**. After applying the schema, use public `migrateLocalRuntimeFiles({ database, objects, homesRoot, workId, kind: 'artifacts' | 'workspace' })` for each committed run / routed session on its source node. It verifies local and uploaded hashes, requires drained workers, and refuses missing files or conflicting checkpoints. Record the returned manifest, check all source directories, and keep backups; a zero-generation nonempty home is refused during recovery. This helper does not infer a missing source as an empty workspace. Resume only after every required source has been imported and checked.

## Artifacts and UI

Artifacts are limited to 16 MiB. The control plane snapshots them by content hash before committing the message. `readArtifact()` checks the authenticated run identity, manifest entry, path containment, size, and SHA-256 digest before returning bytes.

The browser consumes committed messages and ordered events through `@lyyzka/lingxios/ui`. Reconnects page through `readEvents()` and then apply `readRunState()`; reducers reject stale fences and request versions. Waiting, partial completion, verification gaps, delivery failure, citations, and artifact provenance stay explicit.

New envelopes include `citationEvidence: CitationEvidence[]`: the deduplicated cited snapshot items (`marker`, `sourceId`, `sourceVersion`, `chunkId`, `title`, `excerpt`, optional `url` and `truncated`), without internal action keys. Excerpts retain their original text and are limited to 256 KiB of UTF-8 JSON per envelope; oversized results enter bounded protocol correction and must cite narrower reads. `responseSegments()` validates the evidence against the recorded Markdown spans and sources. Render citation text as answer text and show the matched excerpts as untrusted plain text, never HTML. `support: not_assessed` records provenance without asserting semantic verification. Runtime policy receives the same frozen evidence used for the candidate, including recorded tool reads.

## Cognitive memory

`control.memory.scopes(identity)` returns the current authorized effective scopes. Authenticate the identity at the host boundary. For IM administration, include the original run's `workId` (the ingest result's `runId`), tenant, Agent, principal, native session and optional thread. Treat returned scope IDs as opaque: IM scopes bind the frozen audience and policy version as well as the conversation and identity. Pass a returned scope to the administration methods; each operation reauthorizes access, so discovery is not a lasting grant. An empty array means no product-authorized scopes. Do not omit `workId` or reconstruct the digest to access an IM run's memory.

Memory is optional. The product resolves scopes from authenticated identities, including original source identities during history search and maintenance. Administrative calls require no Worker lease; authenticate the caller before constructing `MemoryIdentity`. Scope names remain product-defined. Initialization saves only the supplied content.

```ts
const control = await createLingxiOS({
  database,
  memory: {
    resolveScopes: async (identity, db) => {
      // Use the product's current ACL here. Never trust a client-supplied scope.
      return productMemoryScopes(identity, db)
    },
    contextBudget: { ratio: 0.08, maxTokens: 8000 },
    reflection: { afterInteractions: 5, idleMs: 600_000 },
    // writePolicy, embeddings and evolution remain optional.
  },
})
const identity = { tenantId, agentId, principalId, sessionId }
const [scope] = await control.memory!.scopes(identity)
if (!scope) throw new Error('No authorized memory scope')
const saved = await control.memory!.initialize(identity, {
  scope, sourceRef: 'authenticated-settings', idempotencyKey: requestId,
  documents: [{ path: 'preferences/learning.md', title: 'Learning preference',
    description: 'Preferred explanation format', body: 'Use diagrams and concrete examples.',
    layer: 'core', locked: true }],
})
const page = await control.memory!.list(identity, scope, { prefix: 'preferences/', limit: 8 })
const found = await control.memory!.search(identity, scope, { query: 'diagrams' })
const evidence = await control.memory!.search(identity, scope, { target: 'history', query: 'diagrams' })
const document = await control.memory!.read(identity, scope, saved.documents[0]!.id)
const versions = await control.memory!.history(identity, scope, document!.id)
const diagnostic = await control.memory!.doctor(identity, scope)
const { jobIds } = await control.memory!.reflect(identity, scope)
```

`apply(identity, {scope, changes, sourceRef, idempotencyKey})` atomically creates, updates, moves, merges, expires or deletes up to 12 documents. Update/move/merge/delete/expire require `id` and `expectedVersion`; merge donors also carry versions. `restore(identity, {scope, id, expectedVersion, version, sourceRef, idempotencyKey})` creates a new version. Use `read(identity, scope, id, version)` to inspect historical content. Reuse an idempotency key only for the identical operation. A stale version requires rereading and a fresh operation. `forget(identity, scope)` clears documents, versions, indexes and searchable evidence and increments the scope epoch. Single-document deletion conservatively invalidates all prior source evidence in that scope while retaining other documents. It does not delete product conversations or audit/model records; apply the product's retention policy separately.

Documents have stable IDs, unique relative `.md` paths, titles, descriptions, a 16 KiB UTF-8 body, `core/reference` layers, provenance, versions, locks and expiry. Paths generate the directory; relative Markdown links are discovery hints, not filesystem access. Core memory is loaded independently of query matches. Current original input plus human revisions drive keyword recall through native Chinese/English segmentation, PostgreSQL full-text search and GIN. Optional embeddings merge reciprocal ranks; unavailability reports `keyword_embedding_unavailable`. Empty queries browse; nonempty misses return no unrelated fallback. History remains separate from compacted conversation state, includes roles/timestamps/source IDs, and is restricted to the same tenant, principal and Agent with original-source authorization.

The model receives native `memory.list/read/search/apply/history/restore/forget/reflect/doctor` tools. `read` supports `offset`, byte-bounded `length` and optional `version`; lists/search/history return `nextCursor`. Large ordinary tool results also support existing `observations.read` references. Chat mode exposes none, read mode exposes queries, and execute mode permits reviewed edits. Both direct and Python calls pass through the same private Worker reviewer. Models cannot supply `explicit` or `approved`; the reviewer binds the actual human request, action, document versions, lease, and epoch. Explicit or locked records require a current matching human request; contradictions become diagnostics. This model review is a content judgment, while identity, grants, versions, credentials and epoch checks are enforced by the server. Trusted administrative ingress and host-authored `ActionContext.writeMemory` integrations must validate the user's intent themselves.

Only newly committed, non-delegated interactions enter searchable evidence. The result transaction enqueues only a durable result reference; background capture runs authorization and privacy hooks outside transactions, then rechecks source/request and forgetting epochs in the short evidence transaction. Failed capture retries up to five times without failing the committed response; operations/metrics expose exhausted references. Shared `writePolicy` and baseline credential checks apply before history capture and to document body, title, description, path, conflicts, restoration and synthesis. A policy rejection skips memory evidence without failing the committed response; malformed policies and storage errors are retried by the durable capture queue, not swallowed in the result transaction. Reflection persists per tenant/Agent/principal/scope/epoch, schedules after five interactions or ten minutes idle, reads at most twenty interactions, and runs proposal plus independent review within ninety seconds. Manual reflection returns the same durable job IDs, not a completion claim. Failed jobs back off and stop after three attempts; stale versions regenerate from a fresh snapshot. Explicit/locked memories are protected, assistant statements cannot independently establish user facts, and expired facts require genuinely new observations and a future expiry. Memory stays untrusted data. Its default budget is 8% of the model window, capped at 8,000 conservative estimated tokens; session narration is compacted before further memory trimming, with whole core records first and omitted counts recorded.

`doctor` reports core size, duplicate content, broken local links, expiry, unresolved conflicts and failed reflections; repairs use `apply`. `eval/memory-cases.json` fixes six multi-session cases for continuity, correction, exact detail, conflict, forgetting and principal isolation. Run `npm run eval:memory -- --output eval/results/NEW_NAME` for scripted storage/recall contract metrics. This performs no model learning and marks conflict/model quality as unassessed. Add `--live` with the same model environment variables as `eval:live` to run actual foreground learning and background review. Reports record recall checks, calls, input/output tokens, pending/estimated usage and latency; they retain dataset/runner hashes. Inspect each case's rubric and responses before making a model-quality claim.

## Memory evolution

Memory synthesis may propose tenant-scoped experience, skill, or strategy candidates only when a product configured a frozen benchmark. A candidate is activated after repeated target improvement, no holdout regression, and all deterministic authorization, approval, isolation, and no-code-mutation gates pass. Source revocation expires dependent candidates. Each run pins its active strategy versions; later activation affects new runs only. Trusted administrators can inspect or roll back evaluated versions.

## Operations

`listRuns()`, `readDiagnostics()`, `readOperations()`, metrics, and delivery retry APIs expose bounded metadata without prompts, credentials, tool payloads, or lease secrets. Products must authorize tenant, conversation, or platform-administrator scope before calling them.

Use `doctor()` for schema, Python, storage, and isolation readiness. `npm test` includes package-boundary installation. PostgreSQL recovery, capacity, and Linux image checks are separate release gates. Live-model evaluation is opt-in because it requires provider credentials; its report must retain completion rate, failures, latency, token usage, and cost.

`npm run check:release` emits `release-results/qualifications/<source-hash>.json` only after its gates pass. It binds the exact source files, test-set hash, commit, package/protocol/schema versions and environment to the result. Source changes during a check prevent qualification. The report explicitly records live-model and consuming-product integration as not run; deterministic qualification alone does not authorize a production rollout.
