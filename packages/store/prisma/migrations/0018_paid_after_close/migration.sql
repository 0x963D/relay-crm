ALTER TABLE payments DISABLE TRIGGER payments_guard;
ALTER TABLE payments DROP CONSTRAINT payments_state_shape;
UPDATE payments SET reason=CASE WHEN reported_currency<>currency THEN 'currency mismatch' ELSE 'amount mismatch' END WHERE status='needsReview';
ALTER TABLE payments ENABLE TRIGGER payments_guard;
ALTER TABLE payments ADD CONSTRAINT payments_state_shape CHECK (
  CASE status
    WHEN 'checkoutCreated' THEN method='card' AND decided_at IS NULL AND completed_by IS NULL AND reason IS NULL AND reported_amount IS NULL AND reported_currency IS NULL
    WHEN 'pendingApproval' THEN method='manual' AND decided_at IS NULL AND completed_by IS NULL AND reason IS NULL AND reported_amount IS NULL AND reported_currency IS NULL
    WHEN 'completed' THEN decided_at IS NOT NULL AND completed_by IS NOT NULL AND ((method='card' AND completed_by IN ('providerWebhook','reconciler')) OR (method='manual' AND completed_by='manualApproval')) AND reason IS NULL AND reported_amount IS NULL AND reported_currency IS NULL
    WHEN 'needsReview' THEN method='card' AND decided_at IS NOT NULL AND completed_by IS NULL AND reason IS NOT NULL AND reason IN ('amount mismatch','currency mismatch','paid after close') AND reported_amount IS NOT NULL AND reported_currency IS NOT NULL
    WHEN 'failed' THEN method='card' AND decided_at IS NOT NULL AND completed_by IS NULL AND reason IS NOT NULL AND length(btrim(reason))>0 AND reported_amount IS NULL AND reported_currency IS NULL
    WHEN 'expired' THEN method='card' AND decided_at IS NOT NULL AND completed_by IS NULL AND reason IS NULL AND reported_amount IS NULL AND reported_currency IS NULL
    WHEN 'rejected' THEN method='manual' AND decided_at IS NOT NULL AND completed_by IS NULL AND reason IS NOT NULL AND length(btrim(reason))>0 AND reported_amount IS NULL AND reported_currency IS NULL
    WHEN 'cancelled' THEN method='manual' AND decided_at IS NOT NULL AND completed_by IS NULL AND reason IS NOT NULL AND length(btrim(reason))>0 AND reported_amount IS NULL AND reported_currency IS NULL
    ELSE false END
);
CREATE OR REPLACE FUNCTION guard_payment_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.account_id,NEW.method,NEW.kind,NEW.recorded_by_id,NEW.sold_by_id,NEW.created_at,NEW.sandbox_mode)
     IS DISTINCT FROM (OLD.id,OLD.account_id,OLD.method,OLD.kind,OLD.recorded_by_id,OLD.sold_by_id,OLD.created_at,OLD.sandbox_mode)
  THEN RAISE EXCEPTION 'Payment identity is immutable' USING ERRCODE='23001'; END IF;
  IF (NEW.amount,NEW.currency,NEW.receipt_hash,NEW.reference,NEW.version) IS DISTINCT FROM (OLD.amount,OLD.currency,OLD.receipt_hash,OLD.reference,OLD.version) THEN
    IF OLD.status<>'pendingApproval' OR NEW.status<>'pendingApproval' OR NEW.version<>OLD.version+1
       OR EXISTS(SELECT 1 FROM payment_approvals WHERE payment_id=OLD.id AND voided_at IS NULL)
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
