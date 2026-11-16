CREATE OR REPLACE FUNCTION check_manual_approvals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approval_count integer; all_valid boolean;
BEGIN
  IF NEW.method='manual' AND NEW.status='completed' AND (TG_OP='INSERT' OR OLD.status<>'completed') THEN
    SELECT count(*),coalesce(bool_and(
      NOT EXISTS (SELECT 1 FROM payment_makers m WHERE m.payment_id=NEW.id AND m.user_id=a.approver_id)
      AND a.payment_version=NEW.version AND a.role_version=u.role_version
      AND u.role IN ('accountant','manager','admin','owner')),false)
      INTO approval_count,all_valid FROM payment_approvals a JOIN users u ON u.id=a.approver_id
      WHERE a.payment_id=NEW.id AND a.voided_at IS NULL;
    IF approval_count<>2 OR NOT all_valid THEN RAISE EXCEPTION 'Manual completion requires two valid approvals' USING ERRCODE='23514', CONSTRAINT='manual_approvals_required'; END IF;
  END IF;
  RETURN NULL;
END $$;
