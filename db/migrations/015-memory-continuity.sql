-- Additive, idempotent migration. Drain older workers before enabling continuity.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  IF (SELECT version FROM lingxios.schema_version WHERE singleton) NOT IN (12,13) THEN
    RAISE EXCEPTION 'migration 015 requires schema 12 or 13';
  END IF;
END $$;
ALTER TABLE lingxios.agent_memory_evidence ADD COLUMN IF NOT EXISTS source_complete BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE lingxios.agent_memory_evidence_scopes ADD COLUMN IF NOT EXISTS segment_cursor INTEGER NOT NULL DEFAULT 0 CHECK(segment_cursor>=0);
CREATE TABLE IF NOT EXISTS lingxios.agent_memory_evidence_segments (
  source_run_id TEXT NOT NULL REFERENCES lingxios.agent_memory_evidence(source_run_id) ON DELETE CASCADE,
  segment_no INTEGER NOT NULL CHECK(segment_no>=0),
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  start_offset INTEGER NOT NULL CHECK(start_offset>=0),
  end_offset INTEGER NOT NULL CHECK(end_offset>start_offset),
  body TEXT NOT NULL CHECK(octet_length(body) BETWEEN 1 AND 8000),
  PRIMARY KEY(source_run_id,segment_no)
);
CREATE TABLE IF NOT EXISTS lingxios.agent_memory_scope_moves (
  tenant_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  old_scope_type TEXT NOT NULL,
  old_scope_id TEXT NOT NULL,
  new_scope_type TEXT NOT NULL,
  new_scope_id TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  source_epoch BIGINT NOT NULL,
  target_epoch BIGINT NOT NULL,
  moved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(tenant_id,memory_id)
);
UPDATE lingxios.schema_version SET version=13 WHERE singleton AND version=12;
COMMIT;
