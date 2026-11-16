ALTER TYPE audit_action ADD VALUE 'manualPaymentRecorded';
ALTER TYPE audit_action ADD VALUE 'paymentApproved';
ALTER TYPE audit_action ADD VALUE 'paymentEdited';
ALTER TYPE audit_action ADD VALUE 'receiptRequeued';
ALTER TABLE users ADD COLUMN role_version integer NOT NULL DEFAULT 0 CHECK (role_version >= 0);
ALTER TABLE payments ADD COLUMN version integer NOT NULL DEFAULT 0 CHECK (version >= 0);
ALTER TABLE payments ADD COLUMN receipt_hash text;
ALTER TABLE payments ADD COLUMN reference text;
ALTER TABLE payments ALTER COLUMN next_check_at DROP NOT NULL;
ALTER TABLE payments ALTER COLUMN sandbox_mode DROP NOT NULL;
ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_shape CHECK (
  (method='card' AND receipt_hash IS NULL AND reference IS NULL AND next_check_at IS NOT NULL AND sandbox_mode IS NOT NULL) OR
  (method='manual' AND receipt_hash IS NOT NULL AND receipt_hash ~ '^[a-f0-9]{64}$' AND next_check_at IS NULL AND check_token IS NULL AND sandbox_mode IS NULL)
);
ALTER TABLE payments DROP CONSTRAINT payments_state_shape;
ALTER TABLE payments ADD CONSTRAINT payments_state_shape CHECK (
  CASE status
    WHEN 'checkoutCreated' THEN method='card' AND decided_at IS NULL AND completed_by IS NULL AND reason IS NULL AND reported_amount IS NULL AND reported_currency IS NULL
    WHEN 'pendingApproval' THEN method='manual' AND decided_at IS NULL AND completed_by IS NULL AND reason IS NULL AND reported_amount IS NULL AND reported_currency IS NULL
    WHEN 'completed' THEN decided_at IS NOT NULL AND completed_by IS NOT NULL AND ((method='card' AND completed_by IN ('providerWebhook','reconciler')) OR (method='manual' AND completed_by='manualApproval')) AND reason IS NULL AND reported_amount IS NULL AND reported_currency IS NULL
    WHEN 'needsReview' THEN method='card' AND decided_at IS NOT NULL AND completed_by IS NULL AND reason IS NULL AND reported_amount IS NOT NULL AND reported_currency IS NOT NULL
    WHEN 'failed' THEN method='card' AND decided_at IS NOT NULL AND completed_by IS NULL AND reason IS NOT NULL AND length(btrim(reason))>0 AND reported_amount IS NULL AND reported_currency IS NULL
    WHEN 'expired' THEN method='card' AND decided_at IS NOT NULL AND completed_by IS NULL AND reason IS NULL AND reported_amount IS NULL AND reported_currency IS NULL
    WHEN 'rejected' THEN method='manual' AND decided_at IS NOT NULL AND completed_by IS NULL AND reason IS NOT NULL AND length(btrim(reason))>0 AND reported_amount IS NULL AND reported_currency IS NULL
    WHEN 'cancelled' THEN method='manual' AND decided_at IS NOT NULL AND completed_by IS NULL AND reason IS NOT NULL AND length(btrim(reason))>0 AND reported_amount IS NULL AND reported_currency IS NULL
    ELSE false END
);
CREATE UNIQUE INDEX payments_pending_account_key ON payments(account_id) WHERE status='pendingApproval';
CREATE UNIQUE INDEX payments_live_receipt_key ON payments(receipt_hash) WHERE method='manual' AND status NOT IN ('rejected','cancelled');
CREATE TABLE payment_approvals (
  id uuid PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES payments(id),
  approver_id uuid NOT NULL REFERENCES users(id),
  role_version integer NOT NULL CHECK (role_version>=0),
  at timestamptz(3) NOT NULL,
  voided_at timestamptz(3),
  request_id uuid NOT NULL
);
CREATE INDEX payment_approvals_payment_id_idx ON payment_approvals(payment_id);
CREATE UNIQUE INDEX payment_approvals_active_key ON payment_approvals(payment_id,approver_id) WHERE voided_at IS NULL;
CREATE TRIGGER payment_approvals_no_truncate BEFORE TRUNCATE ON payment_approvals FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER payment_approvals_no_delete BEFORE DELETE ON payment_approvals FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE FUNCTION guard_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payments; u users;
BEGIN
  SELECT * INTO STRICT p FROM payments WHERE id=NEW.payment_id FOR UPDATE;
  SELECT * INTO STRICT u FROM users WHERE id=NEW.approver_id FOR SHARE;
  IF TG_OP='UPDATE' THEN
    IF (NEW.id,NEW.payment_id,NEW.approver_id,NEW.role_version,NEW.at,NEW.request_id) IS DISTINCT FROM (OLD.id,OLD.payment_id,OLD.approver_id,OLD.role_version,OLD.at,OLD.request_id)
      OR OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL OR p.status<>'pendingApproval' OR u.role_version=NEW.role_version
    THEN RAISE EXCEPTION 'Approvals are immutable except role-change voiding' USING ERRCODE='23001'; END IF;
  ELSE
    IF p.status<>'pendingApproval' OR p.recorded_by_id=NEW.approver_id OR u.role_version<>NEW.role_version
      OR u.role NOT IN ('accountant','manager','admin','owner') OR NEW.voided_at IS NOT NULL
    THEN RAISE EXCEPTION 'Approval requires a current eligible person other than the recorder' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_approvals_guard BEFORE INSERT OR UPDATE ON payment_approvals FOR EACH ROW EXECUTE FUNCTION guard_approval();

CREATE FUNCTION bump_role_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.role_version := OLD.role_version + CASE WHEN NEW.role IS DISTINCT FROM OLD.role THEN 1 ELSE 0 END;
  RETURN NEW;
END $$;
CREATE TRIGGER users_role_version BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION bump_role_version();
CREATE FUNCTION void_pending_approvals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role_version<>OLD.role_version THEN
    UPDATE payment_approvals a SET voided_at=clock_timestamp()
      FROM payments p WHERE a.payment_id=p.id AND p.status='pendingApproval' AND a.approver_id=NEW.id AND a.voided_at IS NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER users_void_approvals AFTER UPDATE ON users FOR EACH ROW EXECUTE FUNCTION void_pending_approvals();

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
    (OLD.status='pendingApproval' AND NEW.status IN ('completed','rejected','cancelled'))
  ) THEN RAISE EXCEPTION 'Illegal payment transition' USING ERRCODE='23514'; END IF;
  IF OLD.status NOT IN ('checkoutCreated','pendingApproval') AND NEW.status=OLD.status AND NEW IS DISTINCT FROM OLD
  THEN RAISE EXCEPTION 'Decided payments are immutable' USING ERRCODE='23001'; END IF;
  RETURN NEW;
END $$;
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_kind_shape CHECK (
  (kind='customer' AND account_id IS NOT NULL) OR (kind IN ('cardProviderSandbox','bankTransfersCash') AND account_id IS NULL)
);
ALTER TABLE payment_events DROP CONSTRAINT payment_events_kind_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_kind_check CHECK (kind IN ('checkoutCreated','webhookDelivery','reconcilerCheck','settlement','reviewClosed','manualRecorded','approved','rejected','cancelled','edited','receiptRequeued'));

CREATE FUNCTION check_manual_approvals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid_count integer;
BEGIN
  IF NEW.method='manual' AND NEW.status='completed' AND (TG_OP='INSERT' OR OLD.status<>'completed') THEN
    SELECT count(*) INTO valid_count FROM payment_approvals a JOIN users u ON u.id=a.approver_id
      WHERE a.payment_id=NEW.id AND a.voided_at IS NULL AND a.approver_id<>NEW.recorded_by_id
        AND a.role_version=u.role_version AND u.role IN ('accountant','manager','admin','owner');
    IF valid_count<>2 THEN RAISE EXCEPTION 'Manual completion requires two valid approvals' USING ERRCODE='23514', CONSTRAINT='manual_approvals_required'; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER manual_approvals_required AFTER INSERT OR UPDATE ON payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_manual_approvals();
CREATE OR REPLACE FUNCTION check_payment_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payment_uuid uuid; p payments; posting_uuid uuid; line_count bigint; total numeric; valid_lines bigint;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN payment_uuid := NEW.id;
  ELSIF TG_TABLE_NAME = 'ledger_transactions' THEN payment_uuid := NEW.payment_id;
  ELSE SELECT payment_id INTO payment_uuid FROM ledger_transactions WHERE id = NEW.transaction_id;
  END IF;
  SELECT * INTO STRICT p FROM payments WHERE id = payment_uuid;
  SELECT id INTO posting_uuid FROM ledger_transactions WHERE payment_id = payment_uuid;
  IF (p.status = 'completed') <> (posting_uuid IS NOT NULL) THEN
    RAISE EXCEPTION 'Completed payment must have exactly one posting' USING ERRCODE = '23514', CONSTRAINT = 'payment_posting_required';
  END IF;
  IF posting_uuid IS NULL THEN RETURN NULL; END IF;
  SELECT count(*), coalesce(sum(l.amount),0), count(*) FILTER (WHERE a.currency = p.currency AND
    ((a.kind = 'customer' AND a.account_id = p.account_id AND l.amount = p.amount) OR
     (a.kind = CASE WHEN p.method='manual' THEN 'bankTransfersCash' ELSE 'cardProviderSandbox' END AND l.amount = -p.amount)))
  INTO line_count,total,valid_lines FROM ledger_lines l JOIN ledger_accounts a ON a.id = l.ledger_account_id
  WHERE l.transaction_id = posting_uuid;
  IF line_count <> 2 OR total <> 0 OR valid_lines <> 2 THEN
    RAISE EXCEPTION 'Posting must balance and match the payment' USING ERRCODE = '23514', CONSTRAINT = 'ledger_posting_balanced';
  END IF;
  RETURN NULL;
END $$;

