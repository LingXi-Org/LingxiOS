-- Pre-activation rollback only. Never discard continuity data or reset epochs.
-- Drain Web background work and Workers first. After activation use a compatible fix forward.
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE lingxios.agent_work_items,lingxios.agent_memory_capture,lingxios.agent_memories,lingxios.agent_memory_scopes IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF (SELECT version FROM lingxios.schema_version WHERE singleton) NOT IN (12,13) THEN
    RAISE EXCEPTION 'rollback 015 requires schema 12 or 13';
  END IF;
  IF EXISTS(SELECT 1 FROM lingxios.agent_work_items WHERE status='leased' AND lease_expires_at>NOW())
    OR EXISTS(SELECT 1 FROM lingxios.agent_memory_capture WHERE completed_at IS NULL AND claim_until>NOW()) THEN
    RAISE EXCEPTION 'rollback 015 requires drained Web background work and Workers';
  END IF;
  IF EXISTS(SELECT 1 FROM lingxios.agent_memories WHERE starts_with(scope_id,'stable-memory:'))
    OR EXISTS(SELECT 1 FROM lingxios.agent_memory_scopes WHERE starts_with(scope_id,'stable-memory:')
      AND (epoch>0 OR forgotten_at IS NOT NULL))
    OR EXISTS(SELECT 1 FROM lingxios.agent_memory_scope_moves)
    OR EXISTS(SELECT 1 FROM lingxios.agent_memory_evidence_segments) THEN
    RAISE EXCEPTION 'continuity is activated; use a compatible fix forward to preserve access and progress';
  END IF;
END $$;
-- Retain additive structures for an idempotent re-upgrade; no content is deleted.
UPDATE lingxios.schema_version SET version=12 WHERE singleton AND version=13;
COMMIT;
