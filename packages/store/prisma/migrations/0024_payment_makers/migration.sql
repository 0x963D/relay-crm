ALTER TABLE payments ADD COLUMN terms_set_by_id uuid REFERENCES users(id);
ALTER TABLE payments DISABLE TRIGGER payments_guard;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM payments p WHERE p.method='manual' AND p.version>0 AND NOT EXISTS (SELECT 1 FROM payment_events e WHERE e.payment_id=p.id AND e.kind='edited' AND e.detail->>'actorId' IS NOT NULL)) THEN
    RAISE EXCEPTION 'Edited manual payments are missing their editor history. Resolve them before migrating.';
  END IF;
END $$;
UPDATE payments p SET terms_set_by_id=coalesce((SELECT (e.detail->>'actorId')::uuid FROM payment_events e WHERE e.payment_id=p.id AND e.kind='edited' ORDER BY e.sequence DESC LIMIT 1),p.recorded_by_id) WHERE p.method='manual';
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE payments ENABLE TRIGGER payments_guard;
SET CONSTRAINTS ALL DEFERRED;
ALTER TABLE payments ADD CONSTRAINT payment_maker_shape CHECK ((method='manual')=(terms_set_by_id IS NOT NULL));
ALTER TABLE payment_approvals ADD COLUMN payment_version integer NOT NULL DEFAULT 0 CHECK (payment_version>=0);
ALTER TABLE payment_approvals DISABLE TRIGGER payment_approvals_guard;
UPDATE payment_approvals a SET payment_version=p.version FROM payments p WHERE p.id=a.payment_id;
UPDATE payment_approvals a SET voided_at=clock_timestamp() FROM payments p WHERE p.id=a.payment_id AND p.status='pendingApproval' AND a.voided_at IS NULL AND a.approver_id IN (p.recorded_by_id,p.terms_set_by_id);
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE payment_approvals ENABLE TRIGGER payment_approvals_guard;
SET CONSTRAINTS ALL DEFERRED;
CREATE FUNCTION initialize_payment_maker() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.method='manual' THEN NEW.terms_set_by_id := coalesce(NEW.terms_set_by_id,NEW.recorded_by_id); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_maker BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION initialize_payment_maker();
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
    IF p.status<>'pendingApproval' OR p.recorded_by_id=NEW.approver_id OR p.terms_set_by_id=NEW.approver_id OR p.version<>NEW.payment_version OR u.role_version<>NEW.role_version
      OR u.role NOT IN ('accountant','manager','admin','owner') OR NEW.voided_at IS NOT NULL
    THEN RAISE EXCEPTION 'Approval requires a current eligible person other than a maker' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_payment_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.account_id,NEW.method,NEW.kind,NEW.recorded_by_id,NEW.sold_by_id,NEW.created_at,NEW.sandbox_mode)
     IS DISTINCT FROM (OLD.id,OLD.account_id,OLD.method,OLD.kind,OLD.recorded_by_id,OLD.sold_by_id,OLD.created_at,OLD.sandbox_mode)
  THEN RAISE EXCEPTION 'Payment identity is immutable' USING ERRCODE='23001'; END IF;
  IF (NEW.amount,NEW.currency,NEW.receipt_hash,NEW.reference,NEW.version,NEW.terms_set_by_id) IS DISTINCT FROM (OLD.amount,OLD.currency,OLD.receipt_hash,OLD.reference,OLD.version,OLD.terms_set_by_id) THEN
    IF OLD.status<>'pendingApproval' OR NEW.status<>'pendingApproval' OR NEW.version<>OLD.version+1
    THEN RAISE EXCEPTION 'Refresh before editing approved payment terms' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.status<>OLD.status AND NOT (
    (OLD.status='checkoutCreated' AND NEW.status IN ('completed','failed','expired','needsReview')) OR
    (OLD.status='needsReview' AND NEW.status='failed') OR
    (OLD.status IN ('failed','expired') AND NEW.status='needsReview' AND NEW.reason='paid after close') OR
    (OLD.status='pendingApproval' AND NEW.status IN ('completed','rejected','cancelled'))
  ) THEN RAISE EXCEPTION 'Illegal payment transition' USING ERRCODE='23514'; END IF;
  IF OLD.status NOT IN ('checkoutCreated','pendingApproval') AND NEW.status=OLD.status AND NEW IS DISTINCT FROM OLD
  THEN RAISE EXCEPTION 'Decided payments are immutable' USING ERRCODE='23001'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION check_manual_approvals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid_count integer;
BEGIN
  IF NEW.method='manual' AND NEW.status='completed' AND (TG_OP='INSERT' OR OLD.status<>'completed') THEN
    SELECT count(*) INTO valid_count FROM payment_approvals a JOIN users u ON u.id=a.approver_id
      WHERE a.payment_id=NEW.id AND a.voided_at IS NULL AND a.approver_id<>NEW.recorded_by_id
        AND a.approver_id<>NEW.terms_set_by_id AND a.payment_version=NEW.version
        AND a.role_version=u.role_version AND u.role IN ('accountant','manager','admin','owner');
    IF valid_count<>2 THEN RAISE EXCEPTION 'Manual completion requires two valid approvals' USING ERRCODE='23514', CONSTRAINT='manual_approvals_required'; END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION void_edited_approvals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version<>OLD.version THEN
    UPDATE payment_approvals SET voided_at=clock_timestamp() WHERE payment_id=NEW.id AND voided_at IS NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER payments_void_approvals AFTER UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION void_edited_approvals();
