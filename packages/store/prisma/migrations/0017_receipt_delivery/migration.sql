ALTER TABLE outbox ADD COLUMN recipient text;
UPDATE outbox o SET recipient=l.email FROM payments p JOIN leads l ON l.account_id=p.account_id WHERE o.payment_id=p.id;
ALTER TABLE outbox ADD COLUMN cycle_attempts integer NOT NULL DEFAULT 0 CHECK (cycle_attempts BETWEEN 0 AND 4);
ALTER TABLE outbox ALTER COLUMN next_attempt_at DROP NOT NULL;
CREATE INDEX outbox_due_idx ON outbox(next_attempt_at) WHERE state IN ('pending','failed');
CREATE TABLE receipt_attempts (
  id uuid PRIMARY KEY,
  outbox_id uuid NOT NULL REFERENCES outbox(id),
  number integer NOT NULL CHECK (number>=0),
  state text NOT NULL CHECK (state IN ('sent','suppressed','failed','unknown')),
  reason text,
  started_at timestamptz(3) NOT NULL,
  finished_at timestamptz(3),
  CONSTRAINT receipt_attempts_outbox_id_number_key UNIQUE(outbox_id,number)
);
CREATE TABLE email_suppressions (
  email text PRIMARY KEY CHECK (email=lower(btrim(email))),
  reason text NOT NULL CHECK (length(btrim(reason))>0),
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE FUNCTION guard_receipt_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.finished_at IS NOT NULL OR NEW.finished_at IS NULL OR
    (NEW.id,NEW.outbox_id,NEW.number,NEW.started_at) IS DISTINCT FROM (OLD.id,OLD.outbox_id,OLD.number,OLD.started_at)
  THEN RAISE EXCEPTION 'A finished receipt attempt is immutable' USING ERRCODE='23001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receipt_attempts_guard BEFORE UPDATE ON receipt_attempts FOR EACH ROW EXECUTE FUNCTION guard_receipt_attempt();
CREATE TRIGGER receipt_attempts_no_delete BEFORE DELETE ON receipt_attempts FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER receipt_attempts_no_truncate BEFORE TRUNCATE ON receipt_attempts FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
