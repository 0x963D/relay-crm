CREATE TABLE payment_makers (
  payment_id uuid NOT NULL REFERENCES payments(id),
  user_id uuid NOT NULL REFERENCES users(id),
  at timestamptz(3) NOT NULL,
  PRIMARY KEY (payment_id,user_id)
);
INSERT INTO payment_makers SELECT id,recorded_by_id,created_at FROM payments WHERE method='manual';
INSERT INTO payment_makers
  SELECT p.id,(e.detail->>'actorId')::uuid,min(e.at)
  FROM payments p JOIN payment_events e ON e.payment_id=p.id
  WHERE p.method='manual' AND e.kind='edited'
  GROUP BY p.id,(e.detail->>'actorId')::uuid
  ON CONFLICT DO NOTHING;
ALTER TABLE payment_approvals DISABLE TRIGGER payment_approvals_guard;
UPDATE payment_approvals a SET voided_at=clock_timestamp()
FROM payments p WHERE p.id=a.payment_id AND p.status='pendingApproval' AND a.voided_at IS NULL
  AND EXISTS (SELECT 1 FROM payment_makers m WHERE m.payment_id=p.id AND m.user_id=a.approver_id);
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE payment_approvals ENABLE TRIGGER payment_approvals_guard;
SET CONSTRAINTS ALL DEFERRED;
DROP TRIGGER payments_maker ON payments;
DROP FUNCTION initialize_payment_maker();
ALTER TABLE payments DROP COLUMN terms_set_by_id;
CREATE TRIGGER payment_makers_append_only BEFORE UPDATE OR DELETE ON payment_makers FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER payment_makers_no_truncate BEFORE TRUNCATE ON payment_makers FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
GRANT SELECT,INSERT ON payment_makers TO relay_app;
CREATE FUNCTION record_payment_maker() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='payments' THEN
    IF NEW.method='manual' THEN
      INSERT INTO payment_makers VALUES (NEW.id,NEW.recorded_by_id,NEW.created_at);
    END IF;
  ELSIF NEW.kind='edited' THEN
    INSERT INTO payment_makers VALUES (NEW.payment_id,(NEW.detail->>'actorId')::uuid,NEW.at) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER payments_maker AFTER INSERT ON payments FOR EACH ROW EXECUTE FUNCTION record_payment_maker();
CREATE TRIGGER payment_events_maker AFTER INSERT ON payment_events FOR EACH ROW EXECUTE FUNCTION record_payment_maker();
CREATE FUNCTION require_payment_editor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.method='manual' AND NEW.version<>OLD.version AND NOT EXISTS (
    SELECT 1 FROM payment_events e JOIN payment_makers m ON m.payment_id=e.payment_id AND m.user_id=(e.detail->>'actorId')::uuid
    WHERE e.payment_id=NEW.id AND e.kind='edited' AND (e.detail->>'version')::integer=NEW.version
  ) THEN RAISE EXCEPTION 'Payment edits require their maker event' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payment_editor_required AFTER UPDATE ON payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_payment_editor();
CREATE OR REPLACE FUNCTION guard_payment_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.account_id,NEW.method,NEW.kind,NEW.recorded_by_id,NEW.sold_by_id,NEW.created_at,NEW.sandbox_mode)
     IS DISTINCT FROM (OLD.id,OLD.account_id,OLD.method,OLD.kind,OLD.recorded_by_id,OLD.sold_by_id,OLD.created_at,OLD.sandbox_mode)
  THEN RAISE EXCEPTION 'Payment identity is immutable' USING ERRCODE='23001'; END IF;
  IF (NEW.amount,NEW.currency,NEW.receipt_hash,NEW.reference,NEW.version) IS DISTINCT FROM (OLD.amount,OLD.currency,OLD.receipt_hash,OLD.reference,OLD.version) THEN
    IF OLD.status<>'pendingApproval' OR NEW.status<>'pendingApproval' OR NEW.version<>OLD.version+1
    THEN RAISE EXCEPTION 'Refresh before editing approved payment terms' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.status<>OLD.status AND NOT (
    (OLD.status='checkoutCreated' AND NEW.status IN ('completed','failed','expired','needsReview')) OR
    (OLD.status='needsReview' AND NEW.status='failed') OR
    (OLD.status IN ('failed','expired') AND NEW.status='needsReview' AND NEW.reason='paid after close') OR
    (OLD.status='pendingApproval' AND NEW.status IN ('completed','rejected','cancelled'))
  ) THEN RAISE EXCEPTION 'Illegal payment transition' USING ERRCODE='23514'; END IF;
  IF OLD.status NOT IN ('checkoutCreated','pendingApproval') AND NEW.status=OLD.status AND (to_jsonb(NEW) - ARRAY['next_check_at','check_token','provider_final','creation_pending_until']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['next_check_at','check_token','provider_final','creation_pending_until'])
  THEN RAISE EXCEPTION 'Decided payments are immutable' USING ERRCODE='23001'; END IF;
  IF OLD.provider_final AND NOT NEW.provider_final THEN
    RAISE EXCEPTION 'Provider finality is permanent' USING ERRCODE='23001';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payments; u users;
BEGIN
  SELECT * INTO STRICT p FROM payments WHERE id=NEW.payment_id FOR UPDATE;
  SELECT * INTO STRICT u FROM users WHERE id=NEW.approver_id FOR SHARE;
  IF TG_OP='UPDATE' THEN
    IF (NEW.id,NEW.payment_id,NEW.approver_id,NEW.role_version,NEW.payment_version,NEW.at,NEW.request_id) IS DISTINCT FROM (OLD.id,OLD.payment_id,OLD.approver_id,OLD.role_version,OLD.payment_version,OLD.at,OLD.request_id)
      OR OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL OR p.status<>'pendingApproval' OR (u.role_version=NEW.role_version AND p.version=NEW.payment_version)
    THEN RAISE EXCEPTION 'Approvals are immutable except role or terms-change voiding' USING ERRCODE='23001'; END IF;
  ELSE
    IF p.status<>'pendingApproval' OR p.recorded_by_id=NEW.approver_id OR EXISTS (SELECT 1 FROM payment_makers m WHERE m.payment_id=p.id AND m.user_id=NEW.approver_id) OR p.version<>NEW.payment_version OR u.role_version<>NEW.role_version
      OR u.role NOT IN ('accountant','manager','admin','owner') OR NEW.voided_at IS NOT NULL
    THEN RAISE EXCEPTION 'Approval requires a current eligible person other than a maker' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION check_manual_approvals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid_count integer;
BEGIN
  IF NEW.method='manual' AND NEW.status='completed' AND (TG_OP='INSERT' OR OLD.status<>'completed') THEN
    SELECT count(*) INTO valid_count FROM payment_approvals a JOIN users u ON u.id=a.approver_id
      WHERE a.payment_id=NEW.id AND a.voided_at IS NULL AND a.approver_id<>NEW.recorded_by_id
        AND NOT EXISTS (SELECT 1 FROM payment_makers m WHERE m.payment_id=NEW.id AND m.user_id=a.approver_id) AND a.payment_version=NEW.version
        AND a.role_version=u.role_version AND u.role IN ('accountant','manager','admin','owner');
    IF valid_count<>2 THEN RAISE EXCEPTION 'Manual completion requires two valid approvals' USING ERRCODE='23514', CONSTRAINT='manual_approvals_required'; END IF;
  END IF;
  RETURN NULL;
END $$;

