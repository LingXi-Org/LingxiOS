-- Explicit native13 to native14 upgrade. Drain Web background work and Workers.
-- No runtime DDL. Keep activation/resolution history; use a compatible fix forward.
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE lingxios.agent_work_items IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF (SELECT version FROM lingxios.schema_version WHERE singleton) IS DISTINCT FROM 13 THEN
    RAISE EXCEPTION 'migration 016 requires schema 13';
  END IF;
  IF EXISTS(SELECT 1 FROM lingxios.agent_work_items WHERE status='leased' AND lease_expires_at>NOW()) THEN
    RAISE EXCEPTION 'migration 016 requires drained Workers';
  END IF;
END $$;
CREATE TABLE lingxios.agent_skill_activations (
  id TEXT PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
  work_id TEXT NOT NULL REFERENCES lingxios.agent_work_items(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  request_version INT NOT NULL CHECK(request_version>0),
  skill_name TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  skill_hash TEXT NOT NULL CHECK(skill_hash ~ '^[a-f0-9]{64}$'),
  checker TEXT NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolution TEXT CHECK(resolution IN ('delivered','unsupported','failed')),
  resolved_candidate_hash TEXT CHECK(resolved_candidate_hash ~ '^[a-f0-9]{64}$'),
  resolved_at TIMESTAMPTZ,
  CHECK ((resolution IS NULL AND resolved_candidate_hash IS NULL AND resolved_at IS NULL)
    OR (resolution IS NOT NULL AND resolved_candidate_hash IS NOT NULL AND resolved_at IS NOT NULL)),
  UNIQUE(work_id,request_version,skill_name)
);
UPDATE lingxios.schema_version SET version=14 WHERE singleton;
COMMIT;
