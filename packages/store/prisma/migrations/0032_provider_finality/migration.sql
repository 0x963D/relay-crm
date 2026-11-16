ALTER TABLE payments ADD COLUMN provider_final boolean NOT NULL DEFAULT false;
ALTER TABLE payments ADD COLUMN creation_pending_until timestamptz(3);
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
  IF OLD.status NOT IN ('checkoutCreated','pendingApproval') AND NEW.status=OLD.status AND (to_jsonb(NEW) - ARRAY['next_check_at','check_token','provider_final','creation_pending_until']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['next_check_at','check_token','provider_final','creation_pending_until'])
  THEN RAISE EXCEPTION 'Decided payments are immutable' USING ERRCODE='23001'; END IF;
  IF OLD.provider_final AND NOT NEW.provider_final THEN
    RAISE EXCEPTION 'Provider finality is permanent' USING ERRCODE='23001';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE payment_events DROP CONSTRAINT payment_events_kind_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_kind_check CHECK (kind IN ('checkoutCreated','webhookDelivery','reconcilerCheck','settlement','reviewClosed','checkoutClosed','manualRecorded','approved','rejected','cancelled','edited','receiptRequeued','receiptRecordingFailed','checkoutCancellation'));
