# Final b8 qualification failure model

No production, deployment, package publishing, Docker changes or credential changes.
Source: b8bbef2762c782c75079c3f81113296e95d17bb1; legacy portable handoff: 4c13bf6adfc9e7b8891d45f2d1afb3665d3f860f.

1. Diagnostic event/log serialization can retain nested memory receipts, provider finish reasons, generic errors or heartbeat errors; protected authorized input and business receipts must remain intact.
2. Forget can race inventory/publication/quota/retry, and durable receipts/compaction/legacy summaries can reintroduce forgotten data after restart. Withhold unproven legacy summaries only in model projection, retaining original history and clean/user/public-answer controls.
3. Current authorized stable-scope owner must be able to delete after source-room revocation without allowing rewrites, stale versions, read-only writes or replay duplication.
4. Rejected first synthesis proposal must advance persisted segment cursor and schedule unseen source windows; no duplicate facts or infinite retry of rejected segments.
5. Schema13 rollback must reject activation represented solely by stable-scope epoch/forgotten_at; untouched empty native schema can roll back. Product cutover remains fix-forward.
6. Final admission must serialize with unsettled call settlement, bind server request revision and live lease, and check actual clock after waiting. Test final-first and record-first using actual PostgreSQL locks, plus parallel normal reserve/record and expiration while admission awaits. PGlite is insufficient for this property.

The original real-PG probe scripts are absent from the portable handoff. A new independent, counts-only probe will use the existing local test PostgreSQL service at 127.0.0.1:55432 and a newly-created exclusive synthetic database; no shared product test tables are modified. It must verify its target, refuse an existing database, preserve failed receipts, and clean up only its own newly-created database after all connections close. It must observe pg_stat_activity Lock waits rather than assume blocking from sleep alone. No provider calls.

Product exact SHA is pending confirmation. PR224 cef2349 and release-213-218 f62c3b3 are not silently interchangeable. Existing provider evidence is historical, not b8 evidence.
