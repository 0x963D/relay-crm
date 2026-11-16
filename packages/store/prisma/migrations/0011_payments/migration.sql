ALTER TYPE audit_action ADD VALUE 'checkoutCreated';
ALTER TYPE audit_action ADD VALUE 'paymentStateChanged';
ALTER TYPE audit_action ADD VALUE 'paymentReviewClosed';
ALTER TYPE audit_action ADD VALUE 'ledgerPosted';
ALTER TYPE audit_subject_type ADD VALUE 'payment';
ALTER TYPE audit_subject_type ADD VALUE 'ledger';

CREATE TABLE payments (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  amount bigint NOT NULL CHECK (amount > 0),
  currency text NOT NULL CHECK (currency IN ('AED','EUR','GBP','JPY','KWD','USD')),
  method text NOT NULL DEFAULT 'card' CHECK (method = 'card'),
  kind text NOT NULL CHECK (kind IN ('first','repeat')),
  status text NOT NULL DEFAULT 'checkoutCreated',
  recorded_by_id uuid NOT NULL REFERENCES users(id),
  sold_by_id uuid REFERENCES users(id),
  created_at timestamptz(3) NOT NULL,
  decided_at timestamptz(3),
  completed_by text,
  reported_amount bigint,
  reported_currency text,
  reason text,
  next_check_at timestamptz(3) NOT NULL,
  check_token uuid,
  sandbox_mode text NOT NULL CHECK (sandbox_mode IN ('normal','drop','twice','late','differentAmount')),
  CONSTRAINT payments_state_shape CHECK (
    CASE status
      WHEN 'checkoutCreated' THEN decided_at IS NULL AND completed_by IS NULL AND reason IS NULL AND reported_amount IS NULL AND reported_currency IS NULL
      WHEN 'completed' THEN decided_at IS NOT NULL AND completed_by IS NOT NULL AND completed_by IN ('providerWebhook','reconciler') AND reason IS NULL AND reported_amount IS NULL AND reported_currency IS NULL
      WHEN 'needsReview' THEN decided_at IS NOT NULL AND completed_by IS NULL AND reason IS NULL AND reported_amount IS NOT NULL AND reported_currency IS NOT NULL
      WHEN 'failed' THEN decided_at IS NOT NULL AND completed_by IS NULL AND reason IS NOT NULL AND length(btrim(reason)) > 0 AND reported_amount IS NULL AND reported_currency IS NULL
      WHEN 'expired' THEN decided_at IS NOT NULL AND completed_by IS NULL AND reason IS NULL AND reported_amount IS NULL AND reported_currency IS NULL
      ELSE false END
  )
);
CREATE INDEX payments_status_next_check_at_idx ON payments(status,next_check_at);
CREATE INDEX payments_account_id_created_at_idx ON payments(account_id,created_at);

CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY,
  account_id uuid REFERENCES accounts(id),
  kind text NOT NULL,
  currency text NOT NULL CHECK (currency IN ('AED','EUR','GBP','JPY','KWD','USD')),
  CHECK ((kind = 'customer' AND account_id IS NOT NULL) OR (kind = 'cardProviderSandbox' AND account_id IS NULL))
);
CREATE UNIQUE INDEX ledger_accounts_account_id_currency_key ON ledger_accounts(account_id,currency);
CREATE UNIQUE INDEX ledger_accounts_provider_currency_key ON ledger_accounts(kind,currency) WHERE account_id IS NULL;
CREATE TABLE ledger_transactions (
  id uuid PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES payments(id),
  at timestamptz(3) NOT NULL
);
CREATE UNIQUE INDEX ledger_transactions_payment_id_key ON ledger_transactions(payment_id);
CREATE TABLE ledger_lines (
  id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES ledger_transactions(id),
  ledger_account_id uuid NOT NULL REFERENCES ledger_accounts(id),
  amount bigint NOT NULL CHECK (amount <> 0)
);
CREATE INDEX ledger_lines_transaction_id_idx ON ledger_lines(transaction_id);
CREATE INDEX ledger_lines_ledger_account_id_idx ON ledger_lines(ledger_account_id);

CREATE TABLE payment_events (
  sequence bigserial PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES payments(id),
  kind text NOT NULL CHECK (kind IN ('checkoutCreated','webhookDelivery','reconcilerCheck','settlement','reviewClosed')),
  at timestamptz(3) NOT NULL,
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object')
);
CREATE INDEX payment_events_payment_id_sequence_idx ON payment_events(payment_id,sequence);
CREATE TABLE webhook_inbox (
  event_id text PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES payments(id),
  payload_hash text NOT NULL,
  received_at timestamptz(3) NOT NULL
);
CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES payments(id),
  topic text NOT NULL CHECK (topic = 'paymentCompleted'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','suppressed','failed','unknown')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token uuid,
  lease_until timestamptz(3),
  next_attempt_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL,
  CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
CREATE UNIQUE INDEX outbox_payment_id_key ON outbox(payment_id);
CREATE TABLE sandbox_checkouts (
  id uuid PRIMARY KEY,
  amount bigint NOT NULL CHECK (amount > 0),
  currency text NOT NULL CHECK (currency IN ('AED','EUR','GBP','JPY','KWD','USD')),
  mode text NOT NULL CHECK (mode IN ('normal','drop','twice','late','differentAmount')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','expired')),
  event_id uuid NOT NULL
);
CREATE UNIQUE INDEX sandbox_checkouts_event_id_key ON sandbox_checkouts(event_id);

CREATE TRIGGER ledger_accounts_append_only BEFORE UPDATE OR DELETE ON ledger_accounts FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER ledger_lines_append_only BEFORE UPDATE OR DELETE ON ledger_lines FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER payment_events_append_only BEFORE UPDATE OR DELETE ON payment_events FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER webhook_inbox_append_only BEFORE UPDATE OR DELETE ON webhook_inbox FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE FUNCTION guard_payment_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.account_id,NEW.amount,NEW.currency,NEW.method,NEW.kind,NEW.recorded_by_id,NEW.sold_by_id,NEW.created_at,NEW.sandbox_mode)
     IS DISTINCT FROM (OLD.id,OLD.account_id,OLD.amount,OLD.currency,OLD.method,OLD.kind,OLD.recorded_by_id,OLD.sold_by_id,OLD.created_at,OLD.sandbox_mode)
  THEN RAISE EXCEPTION 'Payment terms are immutable' USING ERRCODE = '23001'; END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'checkoutCreated' AND NEW.status IN ('completed','failed','expired','needsReview')) OR
    (OLD.status = 'needsReview' AND NEW.status = 'failed')
  ) THEN RAISE EXCEPTION 'Illegal payment transition' USING ERRCODE = '23514'; END IF;
  IF OLD.status <> 'checkoutCreated' AND NEW.status = OLD.status AND NEW IS DISTINCT FROM OLD
  THEN RAISE EXCEPTION 'Decided payments are immutable' USING ERRCODE = '23001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_guard BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION guard_payment_change();

-- Deferred checks see both lines and the final payment state, regardless of insert order.
CREATE FUNCTION check_payment_posting() RETURNS trigger LANGUAGE plpgsql AS $$
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
     (a.kind = 'cardProviderSandbox' AND l.amount = -p.amount)))
  INTO line_count,total,valid_lines FROM ledger_lines l JOIN ledger_accounts a ON a.id = l.ledger_account_id
  WHERE l.transaction_id = posting_uuid;
  IF line_count <> 2 OR total <> 0 OR valid_lines <> 2 THEN
    RAISE EXCEPTION 'Posting must balance and match the payment' USING ERRCODE = '23514', CONSTRAINT = 'ledger_posting_balanced';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payment_posting_required AFTER INSERT OR UPDATE ON payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_payment_posting();
CREATE CONSTRAINT TRIGGER ledger_posting_balanced AFTER INSERT ON ledger_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_payment_posting();
CREATE CONSTRAINT TRIGGER ledger_lines_balanced AFTER INSERT ON ledger_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_payment_posting();
