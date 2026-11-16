REVOKE UPDATE ON outbox FROM relay_app;
GRANT UPDATE(state,attempts,cycle_attempts,lease_token,lease_until,next_attempt_at) ON outbox TO relay_app;

CREATE FUNCTION guard_receipt_lifetime_count() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'A receipt lifetime attempt count cannot decrease.' USING ERRCODE='23514', CONSTRAINT='outbox_lifetime_attempts';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER outbox_lifetime_attempts BEFORE UPDATE ON outbox FOR EACH ROW EXECUTE FUNCTION guard_receipt_lifetime_count();
