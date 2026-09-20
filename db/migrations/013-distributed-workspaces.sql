-- Shared checkpoint references. Bytes are uploaded before the fenced transaction commits.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  IF (SELECT version FROM lingxios.schema_version WHERE singleton) NOT IN (10,11) THEN
    RAISE EXCEPTION 'migration 013 requires schema 10 or 11';
  END IF;
END $$;
ALTER TABLE lingxios.agent_steps ADD COLUMN IF NOT EXISTS workspace_checkpoint JSONB;
CREATE TABLE IF NOT EXISTS lingxios.agent_workspace_checkpoints (
  session_key TEXT PRIMARY KEY REFERENCES lingxios.agent_os_sessions(session_key) ON DELETE CASCADE,
  generation BIGINT NOT NULL CHECK(generation > 0),
  entries JSONB NOT NULL CHECK(jsonb_typeof(entries)='array' AND jsonb_array_length(entries)<=4096),
  work_id TEXT NOT NULL REFERENCES lingxios.agent_work_items(id),
  fence BIGINT NOT NULL CHECK(fence>0),
  request_version INTEGER NOT NULL CHECK(request_version>0),
  step_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
UPDATE lingxios.schema_version SET version=11 WHERE singleton;
COMMIT;
