-- Drain old workers before upgrading. Historical terminal work is deliberately not replayed.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  IF (SELECT version FROM lingxios.schema_version WHERE singleton) <> 11 THEN
    RAISE EXCEPTION 'migration 014 requires schema 11';
  END IF;
END $$;
ALTER TABLE lingxios.agent_work_items ADD COLUMN terminal_reason TEXT CHECK (terminal_reason IN
  ('context_limit','budget_limit','model_unavailable','permission_denied','dependency_unavailable','cancelled','interrupted','execution_failed'));

-- Separate delivery intent: failed/cancelled work never acquires a fabricated successful result.
CREATE TABLE lingxios.agent_terminal_outbox (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  root_work_id TEXT NOT NULL REFERENCES lingxios.agent_work_items(id) ON DELETE CASCADE,
  request_version INTEGER NOT NULL CHECK(request_version>0),
  status TEXT NOT NULL CHECK(status IN ('failed','cancelled')),
  reason TEXT NOT NULL CHECK(reason IN ('context_limit','budget_limit','model_unavailable','permission_denied',
    'dependency_unavailable','cancelled','interrupted','execution_failed')),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK(failed_count>=0),
  cancelled_count INTEGER NOT NULL DEFAULT 0 CHECK(cancelled_count>=0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ, failed_at TIMESTAMPTZ, last_error TEXT,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), claim_token TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 30),
  UNIQUE(root_work_id,request_version)
);
CREATE INDEX agent_terminal_outbox_pending_idx ON lingxios.agent_terminal_outbox(available_at)
  WHERE delivered_at IS NULL AND failed_at IS NULL;

CREATE FUNCTION lingxios.capture_terminal_feedback() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root lingxios.agent_work_items; version INTEGER; root_id TEXT;
BEGIN
  IF NEW.status NOT IN ('failed','cancelled') OR NEW.kind<>'turn'
    OR (TG_OP='UPDATE' AND OLD.status IN ('failed','cancelled')) THEN RETURN NULL; END IF;
  root_id := COALESCE(NEW.meta->>'rootWorkId',NEW.id);
  SELECT * INTO root FROM lingxios.agent_work_items WHERE id=root_id
    AND tenant_id=NEW.tenant_id AND principal_id IS NOT DISTINCT FROM NEW.principal_id;
  IF NOT FOUND OR root.kind<>'turn' OR COALESCE(root.conversation->>'internal','false')='true' THEN RETURN NULL; END IF;
  version := jsonb_array_length(root.steer_inputs)+1;
  -- Children of an obsolete request cannot notify the new request's audience.
  IF root_id<>NEW.id AND NEW.meta->'rootRequestVersion' IS DISTINCT FROM to_jsonb(version) THEN RETURN NULL; END IF;
  INSERT INTO lingxios.agent_terminal_outbox(root_work_id,request_version,status,reason,failed_count,cancelled_count)
    VALUES(root_id,version,NEW.status,COALESCE(NEW.terminal_reason,CASE WHEN NEW.status='cancelled' THEN 'cancelled' ELSE 'execution_failed' END),
      CASE WHEN NEW.status='failed' THEN 1 ELSE 0 END,CASE WHEN NEW.status='cancelled' THEN 1 ELSE 0 END)
    ON CONFLICT(root_work_id,request_version) DO UPDATE SET
      status=CASE WHEN EXCLUDED.status='failed' THEN 'failed' ELSE lingxios.agent_terminal_outbox.status END,
      reason=CASE WHEN lingxios.agent_terminal_outbox.failed_count=0 AND EXCLUDED.failed_count>0
        THEN EXCLUDED.reason ELSE lingxios.agent_terminal_outbox.reason END,
      failed_count=lingxios.agent_terminal_outbox.failed_count+EXCLUDED.failed_count,
      cancelled_count=lingxios.agent_terminal_outbox.cancelled_count+EXCLUDED.cancelled_count;
  RETURN NULL;
END $$;
CREATE TRIGGER agent_work_terminal_feedback AFTER INSERT OR UPDATE OF status ON lingxios.agent_work_items
  FOR EACH ROW EXECUTE FUNCTION lingxios.capture_terminal_feedback();
CREATE TRIGGER agent_terminal_wakeup AFTER INSERT ON lingxios.agent_terminal_outbox
  FOR EACH ROW EXECUTE FUNCTION lingxios.notify_runtime('lingxios_outbox');

UPDATE lingxios.schema_version SET version=12 WHERE singleton;
COMMIT;
