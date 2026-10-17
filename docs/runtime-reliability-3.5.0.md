# Runtime reliability 3.5.0

This release requires schema 12. Drain old workers before the consuming application's explicit transactional migration applies `packageResources().migration014` to schema 11. Existing requests, results, action receipts and business tables remain intact. Historical terminal work is not replayed. Fresh installations apply `packageResources().schema`. Startup performs validation only; it never migrates storage.

Hosts replaying immutable historical migration checks can install `packageResources().schema011` at that historical step, then apply `migration014` in their new migration. The schema-11 asset retains SHA-256 `5d77d0140de93d5c9fc205942c77b850b799d257ef49c056da2af84e15f4bb9f`. Strip the packaged outer transaction only when the host migration runner already owns that transaction; never allow a nested asset `COMMIT` to commit the host migration early.

## Ownership and recovery

`createLingxiOS({ background: { role: 'active' } })` owns adaptive maintenance and separate result, event, usage and terminal delivery lanes. Worker-local control objects used only for context must select `role: 'passive'`. Polling backs off from one to thirty seconds, notifications wake eligible lanes, database scan admission is bounded, and slow deliveries do not block healthy lanes. Metrics distinguish idle scans, queue age and delivery channels. These deterministic checks do not establish a production throughput or 24-hour soak result.

Native failures expose sanitized categories. Actual authorization denial, absent resources, contract/version failures and cancellation are terminal. SQL timeouts and dependency failures remain distinct from authorization. Retry requires proof that no effect occurred, including acknowledged transaction rollback; unknown external effects continue to require reconciliation. Optional memory context may be omitted after dependency or scope-authorization failure, while mandatory context authorization, explicit memory operations and unknown implementation failures remain strict.

## Model and child budgets

One logical model call defaults to at most three attempts and 120 seconds including backoff. Each provider attempt reserves and settles the shared root budget. Driver first-byte, idle and request timers propagate cancellation. HTTP 402, authentication and quota codes are not hot-retried on the same configuration. Process-local circuits are bounded and keyed by a hash of provider, model and credential configuration; one half-open probe owns recovery. Safe diagnostics retain allowlisted status/code/request ID, attempts and elapsed time, never raw response bodies or prompts. Circuits are not distributed across processes.

`WorkerOptions.fallbackModel` is opt-in trusted configuration. It requires a model with verified compatible capabilities/preview format, the same approved price schedule as the root, and an `authorize({ work, purpose, signal })` callback that rechecks the current tenant, data boundary and request. It shares the original deadline, attempt limit, root reservation, resource quota and ledger. It cannot replay tools, bypass context admission, or switch embedding vector spaces. No fallback configuration is enabled by default. Routes with different prices are rejected; configure a separate approved root price policy before using them.

Child work reserves its startup call and one closing call against root call/token/cost/time capacity before enqueue. Reservations use conservative observed prompt and maximum output bounds plus the new assignment; they do not grant extra execution budget. At most four children remain active per root. Actual calls consume their holds; terminal children release unused holds. Structured `budget_limit` diagnostics expose `calls`, `tokens`, `cost`, `deadline` or `reservation`. Missing admission information refuses fanout rather than guessing a cheap cost. A rolled-back graph leaves no child but may record one separately authorized root notification with deduplicated denied targets.

Irreducible context admission preserves the current request, instructions and evidence. Optional memory is shed before deciding whether mandatory input fits. It does not repeatedly compact a request that cannot fit even without history.

## Terminal feedback

Failed or cancelled foreground work persists an independent outbox intent with a unique root/request-version identity. It never fabricates a successful assistant result. Child failures and budget denials aggregate into that identity; background memory work does not publish user notifications. The first delivery claim freezes its safe payload so a later aggregate update cannot mutate a lost-acknowledgement retry. Live work status remains independent of the notification snapshot.

Hosts implement `DeliveryPort.deliverTerminal(work, feedback, context)`. Recheck product authorization, frozen audience and current request version immediately before sending. Use `feedback.id` and `feedback.createdAt` as stable message identity and timestamp, send a system notification with `suppressAgentWake: true`, and do not ingest it as a new agent turn. The host's durable messaging acceptance API must reconcile uncertain delivery rather than resending blindly. Explicit authorization denial stops automatic attempts; infrastructure failure retains a bounded retry intent. `readTerminal`, `readDiagnostics().terminal`, `retryDelivery(identity, 'terminal')` and separate terminal pending/failed gauges expose delivery independently from work/result state. Product authorization is required before operator retry.

## Qualification and release procedure

The release workflow checks the full Node suite/package install, schema migration and concurrency against real PostgreSQL, real process termination/recovery, distributed workspace recovery, capacity, and the confined Linux worker image. Earlier checkpoint `f5526dc` passed [release gates 39002035113](https://github.com/LingXi-Org/LingxiOS/actions/runs/39002035113). Final 3.5.0 qualification must pass on the final PR commit and again on its exact main merge commit.

Only then tag that main commit `v3.5.0`. The existing `publish-package.yml` rejects a mismatched version or a commit without successful main release gates, and uses the repository's existing package credential. Do not add credentials, expand permissions or bypass branch protection. Consumers install exact published `@lyyzka/lingxios@3.5.0`; do not use a copied runtime or local tarball as release evidence.

Controlled real-provider validation, consuming-product migration/integration, complete SPA checks and production soak are separate acceptance work and are not claimed by this runtime qualification. The cloud workspace's local image build was blocked by unavailable Debian HTTP package mirrors; the GitHub Linux release gate supplies the image/sandbox evidence.
