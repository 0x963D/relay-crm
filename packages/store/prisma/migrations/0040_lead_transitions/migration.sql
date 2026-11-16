CREATE FUNCTION guard_lead_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND (
    OLD.status IN ('won','dead') OR
    (OLD.status='lost' AND (NEW.status<>'new' OR
      NEW.previous_owner_id IS DISTINCT FROM OLD.owner_id OR
      NEW.first_assigned_at IS DISTINCT FROM OLD.first_assigned_at))
  ) THEN
    RAISE EXCEPTION 'This closed lead cannot change status.' USING ERRCODE='23514', CONSTRAINT='leads_transition';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER leads_transition BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION guard_lead_transition();

CREATE FUNCTION require_intake_reopening() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM intake_events WHERE lead_id=NEW.id AND outcome='leadReopened'
      AND xmin=pg_current_xact_id()::text::xid
  ) THEN
    RAISE EXCEPTION 'Only a new intake can reopen a lost lead.' USING ERRCODE='23514', CONSTRAINT='leads_intake_reopening';
  END IF;
  RETURN NEW;
END
$$;
CREATE CONSTRAINT TRIGGER leads_intake_reopening AFTER UPDATE ON leads
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD.status='lost' AND NEW.status='new') EXECUTE FUNCTION require_intake_reopening();
