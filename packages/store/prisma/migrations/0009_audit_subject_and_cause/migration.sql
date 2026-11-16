CREATE TYPE audit_action AS ENUM ('leadAssigned', 'leadReopened');
CREATE TYPE audit_subject_type AS ENUM ('lead', 'account');
DROP TRIGGER audit_log_append_only ON audit_log;
ALTER TABLE audit_log ALTER COLUMN action TYPE audit_action USING action::audit_action;
ALTER TABLE audit_log ADD COLUMN subject_type audit_subject_type NOT NULL DEFAULT 'lead';
ALTER TABLE audit_log ALTER COLUMN subject_type DROP DEFAULT;
ALTER TABLE audit_log ADD COLUMN request_id uuid;
-- Original request identifiers were not stored. Each historical row keeps its own correlation ID.
UPDATE audit_log SET request_id = id,
  before = CASE WHEN jsonb_typeof(before->'lifecycle') = 'string'
    THEN jsonb_set(before, '{lifecycle}', (before->>'lifecycle')::jsonb) ELSE before END,
  after = CASE WHEN jsonb_typeof(after->'lifecycle') = 'string'
    THEN jsonb_set(after, '{lifecycle}', (after->>'lifecycle')::jsonb) ELSE after END;
ALTER TABLE audit_log ALTER COLUMN request_id SET NOT NULL;
ALTER TABLE audit_log ADD COLUMN idempotency_id uuid REFERENCES idempotency_records(id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE audit_log ADD CONSTRAINT audit_request_matches_receipt
  CHECK (idempotency_id IS NULL OR request_id = idempotency_id);
ALTER TABLE audit_log ADD CONSTRAINT audit_snapshots_objects CHECK (
  jsonb_typeof(before) = 'object' AND jsonb_typeof(after) = 'object'
  AND (NOT before ? 'lifecycle' OR jsonb_typeof(before->'lifecycle') = 'object')
  AND (NOT after ? 'lifecycle' OR jsonb_typeof(after->'lifecycle') = 'object')
);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE INDEX audit_log_request_id_idx ON audit_log(request_id);
CREATE INDEX audit_log_idempotency_id_idx ON audit_log(idempotency_id);
