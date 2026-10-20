# Continuity fixes

Baseline 627e6627. Failure model was recorded in `docs/issue-216-continuity-fixes-failure-model.md` before code changes. Tests use the real implementation and dedicated PGlite with synthetic data. No external provider or production operations.

- Current-owner deletion: `node --test dist/test/memory-continuity-delete.test.js` failed 0/1 on the baseline (`memory source scope was revoked`) and passed 1/1 after the fix. Controls also require historical-source updates, stale CAS, revoked current write and revoked old-room reads to reject, and repeated deletion to return its durable idempotent result. Build exited 0 both times. Raw receipts: delete-red.txt / delete-green.txt.
