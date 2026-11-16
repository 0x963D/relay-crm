BEGIN;
ALTER TABLE idempotency_records DISABLE TRIGGER idempotency_records_append_only;
-- Historical requests cannot be reconstructed. This marker can never equal a SHA-256 request hash.
UPDATE idempotency_records SET request_hash = 'unrecoverable:' || id::text WHERE request_hash IS NULL;
ALTER TABLE idempotency_records ENABLE TRIGGER idempotency_records_append_only;
ALTER TABLE idempotency_records ALTER COLUMN request_hash SET NOT NULL;
COMMIT;
