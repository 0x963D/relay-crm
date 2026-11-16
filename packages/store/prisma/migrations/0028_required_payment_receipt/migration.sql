DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM payments p WHERE p.status='completed' AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.payment_id=p.id)) THEN
    RAISE EXCEPTION 'Completed payments are missing receipt rows. Resolve them before migrating.';
  END IF;
END $$;
CREATE FUNCTION check_payment_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM payments p WHERE p.id=NEW.id AND p.status='completed' AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.payment_id=p.id)) THEN
    RAISE EXCEPTION 'Completed payment requires a receipt row' USING ERRCODE='23514', CONSTRAINT='payment_outbox_required';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payment_outbox_required AFTER INSERT OR UPDATE ON payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_payment_outbox();
CREATE FUNCTION guard_outbox_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.payment_id,NEW.topic) IS DISTINCT FROM (OLD.id,OLD.payment_id,OLD.topic) THEN
    RAISE EXCEPTION 'Receipt identity is immutable' USING ERRCODE='23001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_identity BEFORE UPDATE ON outbox FOR EACH ROW EXECUTE FUNCTION guard_outbox_identity();
CREATE TRIGGER outbox_no_delete BEFORE DELETE ON outbox FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER outbox_no_truncate BEFORE TRUNCATE ON outbox FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
REVOKE DELETE, TRUNCATE ON outbox FROM relay_app;
