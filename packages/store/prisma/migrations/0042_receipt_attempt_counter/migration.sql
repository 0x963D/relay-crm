REVOKE UPDATE(attempts) ON outbox FROM relay_app;
DROP TRIGGER outbox_lifetime_attempts ON outbox;
DROP FUNCTION guard_receipt_lifetime_count();

CREATE FUNCTION count_receipt_attempt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE affected integer;
BEGIN
  IF NEW.number=0 THEN RETURN NEW; END IF;
  EXECUTE format('UPDATE %I.outbox SET attempts=attempts+1 WHERE id=$1 AND attempts=$2', TG_TABLE_SCHEMA)
    USING NEW.outbox_id, NEW.number-1;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>1 THEN
    RAISE EXCEPTION 'A receipt attempt must advance its lifetime count once.' USING ERRCODE='23514', CONSTRAINT='receipt_attempt_counter';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER receipt_attempt_counter AFTER INSERT ON receipt_attempts FOR EACH ROW EXECUTE FUNCTION count_receipt_attempt();
