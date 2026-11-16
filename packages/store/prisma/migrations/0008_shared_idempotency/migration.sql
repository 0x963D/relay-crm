DROP TRIGGER distributions_append_only ON distributions;
ALTER TABLE distributions RENAME TO idempotency_records;
ALTER TABLE idempotency_records DROP CONSTRAINT distributions_actor_id_fkey;
ALTER TABLE idempotency_records ALTER COLUMN actor_id TYPE text USING 'user:' || actor_id::text;
ALTER TABLE idempotency_records RENAME COLUMN actor_id TO scope;
ALTER TABLE idempotency_records ADD COLUMN operation text NOT NULL DEFAULT 'distribution.submit';
ALTER TABLE idempotency_records ALTER COLUMN operation DROP DEFAULT;
ALTER TABLE idempotency_records ALTER COLUMN result TYPE jsonb
  USING jsonb_build_object('items', result, 'changed', true);
ALTER TABLE idempotency_records RENAME CONSTRAINT distributions_actor_id_key_key TO idempotency_records_scope_key_key;
ALTER TABLE idempotency_records RENAME CONSTRAINT distributions_pkey TO idempotency_records_pkey;
ALTER TABLE idempotency_records ADD CONSTRAINT idempotency_result_object CHECK (jsonb_typeof(result) = 'object');
CREATE TRIGGER idempotency_records_append_only BEFORE UPDATE OR DELETE ON idempotency_records
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
