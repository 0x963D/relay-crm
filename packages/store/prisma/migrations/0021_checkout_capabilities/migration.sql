ALTER TABLE sandbox_checkouts ADD COLUMN payment_id uuid;
UPDATE sandbox_checkouts SET payment_id=id, id=gen_random_uuid();
ALTER TABLE sandbox_checkouts ALTER COLUMN payment_id SET NOT NULL;
ALTER TABLE sandbox_checkouts ADD CONSTRAINT sandbox_checkouts_separate_id CHECK (id<>payment_id);
ALTER TABLE sandbox_checkouts ADD COLUMN token_hash text CHECK (token_hash ~ '^[a-f0-9]{64}$');
CREATE UNIQUE INDEX sandbox_checkouts_payment_id_key ON sandbox_checkouts(payment_id);
CREATE UNIQUE INDEX sandbox_checkouts_token_hash_key ON sandbox_checkouts(token_hash);
