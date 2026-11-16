CREATE SEQUENCE public.payment_events_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE public.ledger_accounts (
    id uuid NOT NULL,
    account_id uuid,
    kind text NOT NULL,
    currency text NOT NULL,
    CONSTRAINT ledger_accounts_currency_check CHECK ((currency = ANY (ARRAY['AED'::text, 'EUR'::text, 'GBP'::text, 'JPY'::text, 'KWD'::text, 'USD'::text]))),
    CONSTRAINT ledger_accounts_kind_shape CHECK ((((kind = 'customer'::text) AND (account_id IS NOT NULL)) OR ((kind = ANY (ARRAY['cardProviderSandbox'::text, 'bankTransfersCash'::text])) AND (account_id IS NULL))))
);

CREATE TABLE public.ledger_lines (
    id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    ledger_account_id uuid NOT NULL,
    side text NOT NULL,
    amount bigint NOT NULL,
    CONSTRAINT ledger_lines_amount_check CHECK ((amount > 0)),
    CONSTRAINT ledger_lines_side_check CHECK ((side = ANY (ARRAY['debit'::text, 'credit'::text])))
);

CREATE TABLE public.ledger_transactions (
    id uuid NOT NULL,
    payment_id uuid NOT NULL,
    at timestamp(3) with time zone NOT NULL
);

CREATE TABLE public.payment_approvals (
    id uuid NOT NULL,
    payment_id uuid NOT NULL,
    approver_id uuid NOT NULL,
    request_id uuid NOT NULL,
    role_version integer NOT NULL,
    payment_version integer NOT NULL,
    at timestamp(3) with time zone NOT NULL,
    voided_at timestamp(3) with time zone,
    CONSTRAINT payment_approvals_payment_version_check CHECK ((payment_version >= 0)),
    CONSTRAINT payment_approvals_role_version_check CHECK ((role_version >= 0))
);

CREATE TABLE public.payment_events (
    sequence bigint DEFAULT nextval('public.payment_events_sequence_seq'::regclass) NOT NULL,
    payment_id uuid NOT NULL,
    kind text NOT NULL,
    detail jsonb NOT NULL,
    at timestamp(3) with time zone NOT NULL,
    CONSTRAINT payment_events_detail_check CHECK ((jsonb_typeof(detail) = 'object'::text)),
    CONSTRAINT payment_events_kind_check CHECK ((kind = ANY (ARRAY['checkoutCreated'::text, 'webhookDelivery'::text, 'reconcilerCheck'::text, 'settlement'::text, 'reviewClosed'::text, 'checkoutClosed'::text, 'manualRecorded'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text, 'edited'::text, 'receiptRequeued'::text, 'receiptRecordingFailed'::text, 'checkoutCancellation'::text])))
);

CREATE TABLE public.payment_makers (
    payment_id uuid NOT NULL,
    user_id uuid NOT NULL,
    at timestamp(3) with time zone NOT NULL
);

CREATE TABLE public.payments (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    amount bigint NOT NULL,
    currency text NOT NULL,
    method text NOT NULL,
    kind text NOT NULL,
    recorded_by_id uuid NOT NULL,
    sold_by_id uuid,
    receipt_hash text,
    reference text,
    sandbox_mode text,
    status text NOT NULL,
    version integer DEFAULT 0 NOT NULL,
    completed_by text,
    reason text,
    reported_amount bigint,
    reported_currency text,
    provider_final boolean DEFAULT false NOT NULL,
    creation_token uuid,
    check_token uuid,
    created_at timestamp(3) with time zone NOT NULL,
    creation_pending_until timestamp(3) with time zone,
    next_check_at timestamp(3) with time zone,
    decided_at timestamp(3) with time zone,
    CONSTRAINT payments_amount_check CHECK ((amount > 0)),
    CONSTRAINT payments_currency_check CHECK ((currency = ANY (ARRAY['AED'::text, 'EUR'::text, 'GBP'::text, 'JPY'::text, 'KWD'::text, 'USD'::text]))),
    CONSTRAINT payments_kind_check CHECK ((kind = ANY (ARRAY['first'::text, 'repeat'::text]))),
    CONSTRAINT payments_method_shape CHECK ((((method = 'card'::text) AND (receipt_hash IS NULL) AND (reference IS NULL) AND (next_check_at IS NOT NULL) AND (sandbox_mode IS NOT NULL)) OR ((method = 'manual'::text) AND (receipt_hash IS NOT NULL) AND (receipt_hash ~ '^[a-f0-9]{64}$'::text) AND (next_check_at IS NULL) AND (check_token IS NULL) AND (sandbox_mode IS NULL)))),
    CONSTRAINT payments_reported_money CHECK ((((reported_amount IS NULL) OR (reported_amount > 0)) AND ((reported_currency IS NULL) OR (reported_currency = ANY (ARRAY['AED'::text, 'EUR'::text, 'GBP'::text, 'JPY'::text, 'KWD'::text, 'USD'::text]))))),
    CONSTRAINT payments_sandbox_mode_check CHECK ((sandbox_mode = ANY (ARRAY['normal'::text, 'drop'::text, 'twice'::text, 'late'::text, 'differentAmount'::text]))),
    CONSTRAINT payments_state_shape CHECK (
CASE status
    WHEN 'checkoutCreated'::text THEN ((method = 'card'::text) AND (decided_at IS NULL) AND (completed_by IS NULL) AND (reason IS NULL) AND (reported_amount IS NULL) AND (reported_currency IS NULL))
    WHEN 'pendingApproval'::text THEN ((method = 'manual'::text) AND (decided_at IS NULL) AND (completed_by IS NULL) AND (reason IS NULL) AND (reported_amount IS NULL) AND (reported_currency IS NULL))
    WHEN 'completed'::text THEN ((decided_at IS NOT NULL) AND (completed_by IS NOT NULL) AND (((method = 'card'::text) AND (completed_by = ANY (ARRAY['providerWebhook'::text, 'reconciler'::text]))) OR ((method = 'manual'::text) AND (completed_by = 'manualApproval'::text))) AND (reason IS NULL) AND (reported_amount IS NULL) AND (reported_currency IS NULL))
    WHEN 'needsReview'::text THEN ((method = 'card'::text) AND (decided_at IS NOT NULL) AND (completed_by IS NULL) AND (reason IS NOT NULL) AND (reason = ANY (ARRAY['amount mismatch'::text, 'currency mismatch'::text, 'paid after close'::text])) AND (reported_amount IS NOT NULL) AND (reported_currency IS NOT NULL))
    WHEN 'failed'::text THEN ((method = 'card'::text) AND (decided_at IS NOT NULL) AND (completed_by IS NULL) AND (reason IS NOT NULL) AND (length(btrim(reason)) > 0) AND (reported_amount IS NULL) AND (reported_currency IS NULL))
    WHEN 'expired'::text THEN ((method = 'card'::text) AND (decided_at IS NOT NULL) AND (completed_by IS NULL) AND (reason IS NULL) AND (reported_amount IS NULL) AND (reported_currency IS NULL))
    WHEN 'rejected'::text THEN ((method = 'manual'::text) AND (decided_at IS NOT NULL) AND (completed_by IS NULL) AND (reason IS NOT NULL) AND (length(btrim(reason)) > 0) AND (reported_amount IS NULL) AND (reported_currency IS NULL))
    WHEN 'cancelled'::text THEN ((method = 'manual'::text) AND (decided_at IS NOT NULL) AND (completed_by IS NULL) AND (reason IS NOT NULL) AND (length(btrim(reason)) > 0) AND (reported_amount IS NULL) AND (reported_currency IS NULL))
    ELSE false
END),
    CONSTRAINT payments_version_check CHECK ((version >= 0))
);

CREATE TABLE public.sandbox_checkouts (
    id uuid NOT NULL,
    payment_id uuid NOT NULL,
    event_id uuid NOT NULL,
    token_hash text NOT NULL,
    amount bigint NOT NULL,
    currency text NOT NULL,
    mode text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp(3) with time zone DEFAULT (CURRENT_TIMESTAMP + '24:00:00'::interval) NOT NULL,
    CONSTRAINT sandbox_checkouts_amount_check CHECK ((amount > 0)),
    CONSTRAINT sandbox_checkouts_currency_check CHECK ((currency = ANY (ARRAY['AED'::text, 'EUR'::text, 'GBP'::text, 'JPY'::text, 'KWD'::text, 'USD'::text]))),
    CONSTRAINT sandbox_checkouts_mode_check CHECK ((mode = ANY (ARRAY['normal'::text, 'drop'::text, 'twice'::text, 'late'::text, 'differentAmount'::text]))),
    CONSTRAINT sandbox_checkouts_separate_id CHECK ((id <> payment_id)),
    CONSTRAINT sandbox_checkouts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text, 'expired'::text]))),
    CONSTRAINT sandbox_checkouts_token_hash_check CHECK ((token_hash ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE public.webhook_inbox (
    event_id text NOT NULL,
    payment_id uuid NOT NULL,
    payload_hash text NOT NULL,
    received_at timestamp(3) with time zone NOT NULL
);

ALTER SEQUENCE public.payment_events_sequence_seq OWNED BY public.payment_events.sequence;

CREATE FUNCTION public.check_manual_approvals() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.check_payment_posting() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
  SELECT count(*), coalesce(sum(CASE l.side WHEN 'credit' THEN l.amount::numeric ELSE -l.amount::numeric END),0), count(*) FILTER (WHERE a.currency = p.currency AND
    ((a.kind = 'customer' AND a.account_id = p.account_id AND l.side='credit' AND l.amount = p.amount) OR
     (a.kind = CASE WHEN p.method='manual' THEN 'bankTransfersCash' ELSE 'cardProviderSandbox' END AND l.side='debit' AND l.amount = p.amount)))
  INTO line_count,total,valid_lines FROM ledger_lines l JOIN ledger_accounts a ON a.id = l.ledger_account_id
  WHERE l.transaction_id = posting_uuid;
  IF line_count <> 2 OR total <> 0 OR valid_lines <> 2 THEN
    RAISE EXCEPTION 'Posting must balance and match the payment' USING ERRCODE = '23514', CONSTRAINT = 'ledger_posting_balanced';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION public.guard_approval() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.guard_payment_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.id,NEW.account_id,NEW.method,NEW.kind,NEW.recorded_by_id,NEW.sold_by_id,NEW.created_at,NEW.sandbox_mode)
     IS DISTINCT FROM (OLD.id,OLD.account_id,OLD.method,OLD.kind,OLD.recorded_by_id,OLD.sold_by_id,OLD.created_at,OLD.sandbox_mode)
  THEN RAISE EXCEPTION 'Payment identity is immutable' USING ERRCODE='23001'; END IF;
  IF (NEW.amount,NEW.currency,NEW.receipt_hash,NEW.reference,NEW.version) IS DISTINCT FROM (OLD.amount,OLD.currency,OLD.receipt_hash,OLD.reference,OLD.version) THEN
    IF OLD.status<>'pendingApproval' OR NEW.status<>'pendingApproval' OR NEW.version<>OLD.version+1
    THEN RAISE EXCEPTION 'Refresh before editing approved payment terms' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.status<>OLD.status AND NOT (
    (OLD.status='checkoutCreated' AND (NEW.status IN ('completed','failed','expired') OR (NEW.status='needsReview' AND NEW.reason IN ('amount mismatch','currency mismatch')))) OR
    (OLD.status='needsReview' AND NEW.status='failed') OR
    (OLD.status IN ('failed','expired') AND NEW.status='needsReview' AND NEW.reason='paid after close') OR
    (OLD.status='pendingApproval' AND NEW.status IN ('completed','rejected','cancelled'))
  ) THEN RAISE EXCEPTION 'Illegal payment transition' USING ERRCODE='23514'; END IF;
  IF OLD.status NOT IN ('checkoutCreated','pendingApproval') AND NEW.status=OLD.status AND (to_jsonb(NEW) - ARRAY['next_check_at','check_token','provider_final','creation_pending_until','creation_token']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['next_check_at','check_token','provider_final','creation_pending_until','creation_token'])
  THEN RAISE EXCEPTION 'Decided payments are immutable' USING ERRCODE='23001'; END IF;
  IF OLD.provider_final AND NOT NEW.provider_final THEN
    RAISE EXCEPTION 'Provider finality is permanent' USING ERRCODE='23001';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.record_payment_maker() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.require_payment_editor() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.method='manual' AND NEW.version<>OLD.version AND NOT EXISTS (
    SELECT 1 FROM payment_events e JOIN payment_makers m ON m.payment_id=e.payment_id AND m.user_id=(e.detail->>'actorId')::uuid
    WHERE e.payment_id=NEW.id AND e.kind='edited' AND (e.detail->>'version')::integer=NEW.version
  ) THEN RAISE EXCEPTION 'Payment edits require their maker event' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION public.void_edited_approvals() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.version<>OLD.version THEN
    UPDATE payment_approvals SET voided_at=clock_timestamp() WHERE payment_id=NEW.id AND voided_at IS NULL;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION public.void_pending_approvals() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.role_version<>OLD.role_version THEN
    UPDATE payment_approvals a SET voided_at=clock_timestamp()
      FROM payments p WHERE a.payment_id=p.id AND p.status='pendingApproval' AND a.approver_id=NEW.id AND a.voided_at IS NULL;
  END IF;
  RETURN NULL;
END $$;

ALTER TABLE ONLY public.ledger_accounts
    ADD CONSTRAINT ledger_accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ledger_lines
    ADD CONSTRAINT ledger_lines_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ledger_transactions
    ADD CONSTRAINT ledger_transactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.payment_approvals
    ADD CONSTRAINT payment_approvals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT payment_events_pkey PRIMARY KEY (sequence);

ALTER TABLE ONLY public.payment_makers
    ADD CONSTRAINT payment_makers_pkey PRIMARY KEY (payment_id, user_id);

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sandbox_checkouts
    ADD CONSTRAINT sandbox_checkouts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.webhook_inbox
    ADD CONSTRAINT webhook_inbox_pkey PRIMARY KEY (event_id);

CREATE UNIQUE INDEX ledger_accounts_account_id_currency_key ON public.ledger_accounts USING btree (account_id, currency);

CREATE UNIQUE INDEX ledger_accounts_provider_currency_key ON public.ledger_accounts USING btree (kind, currency) WHERE (account_id IS NULL);

CREATE INDEX ledger_lines_ledger_account_id_idx ON public.ledger_lines USING btree (ledger_account_id);

CREATE INDEX ledger_lines_transaction_id_idx ON public.ledger_lines USING btree (transaction_id);

CREATE UNIQUE INDEX ledger_transactions_payment_id_key ON public.ledger_transactions USING btree (payment_id);

CREATE UNIQUE INDEX payment_approvals_active_key ON public.payment_approvals USING btree (payment_id, approver_id) WHERE (voided_at IS NULL);

CREATE INDEX payment_approvals_payment_id_idx ON public.payment_approvals USING btree (payment_id);

CREATE INDEX payment_events_payment_id_sequence_idx ON public.payment_events USING btree (payment_id, sequence);

CREATE INDEX payments_account_id_created_at_idx ON public.payments USING btree (account_id, created_at);

CREATE UNIQUE INDEX payments_in_progress_account_key ON public.payments USING btree (account_id) WHERE (status = ANY (ARRAY['pendingApproval'::text, 'checkoutCreated'::text]));

CREATE UNIQUE INDEX payments_live_receipt_key ON public.payments USING btree (receipt_hash) WHERE ((method = 'manual'::text) AND (status <> ALL (ARRAY['rejected'::text, 'cancelled'::text])));

CREATE INDEX payments_status_next_check_at_idx ON public.payments USING btree (status, next_check_at);

CREATE UNIQUE INDEX sandbox_checkouts_event_id_key ON public.sandbox_checkouts USING btree (event_id);

CREATE UNIQUE INDEX sandbox_checkouts_payment_id_key ON public.sandbox_checkouts USING btree (payment_id);

CREATE UNIQUE INDEX sandbox_checkouts_token_hash_key ON public.sandbox_checkouts USING btree (token_hash);

ALTER TABLE ONLY public.ledger_accounts
    ADD CONSTRAINT ledger_accounts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);

ALTER TABLE ONLY public.ledger_lines
    ADD CONSTRAINT ledger_lines_ledger_account_id_fkey FOREIGN KEY (ledger_account_id) REFERENCES public.ledger_accounts(id);

ALTER TABLE ONLY public.ledger_lines
    ADD CONSTRAINT ledger_lines_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.ledger_transactions(id);

ALTER TABLE ONLY public.ledger_transactions
    ADD CONSTRAINT ledger_transactions_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id);

ALTER TABLE ONLY public.payment_approvals
    ADD CONSTRAINT payment_approvals_approver_id_fkey FOREIGN KEY (approver_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.payment_approvals
    ADD CONSTRAINT payment_approvals_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id);

ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT payment_events_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id);

ALTER TABLE ONLY public.payment_makers
    ADD CONSTRAINT payment_makers_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id);

ALTER TABLE ONLY public.payment_makers
    ADD CONSTRAINT payment_makers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_recorded_by_id_fkey FOREIGN KEY (recorded_by_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_sold_by_id_fkey FOREIGN KEY (sold_by_id) REFERENCES public.users(id);

ALTER TABLE ONLY public.webhook_inbox
    ADD CONSTRAINT webhook_inbox_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id);

CREATE TRIGGER ledger_accounts_append_only BEFORE DELETE OR UPDATE ON public.ledger_accounts FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

CREATE TRIGGER ledger_accounts_no_truncate BEFORE TRUNCATE ON public.ledger_accounts FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

CREATE TRIGGER ledger_lines_append_only BEFORE DELETE OR UPDATE ON public.ledger_lines FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

CREATE CONSTRAINT TRIGGER ledger_lines_balanced AFTER INSERT ON public.ledger_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_payment_posting();

CREATE TRIGGER ledger_lines_no_truncate BEFORE TRUNCATE ON public.ledger_lines FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

CREATE CONSTRAINT TRIGGER ledger_posting_balanced AFTER INSERT ON public.ledger_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_payment_posting();

CREATE TRIGGER ledger_transactions_append_only BEFORE DELETE OR UPDATE ON public.ledger_transactions FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

CREATE TRIGGER ledger_transactions_no_truncate BEFORE TRUNCATE ON public.ledger_transactions FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

CREATE CONSTRAINT TRIGGER manual_approvals_required AFTER INSERT OR UPDATE ON public.payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_manual_approvals();

CREATE TRIGGER payment_approvals_guard BEFORE INSERT OR UPDATE ON public.payment_approvals FOR EACH ROW EXECUTE FUNCTION public.guard_approval();

CREATE TRIGGER payment_approvals_no_delete BEFORE DELETE ON public.payment_approvals FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

CREATE TRIGGER payment_approvals_no_truncate BEFORE TRUNCATE ON public.payment_approvals FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

CREATE CONSTRAINT TRIGGER payment_editor_required AFTER UPDATE ON public.payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_payment_editor();

CREATE TRIGGER payment_events_append_only BEFORE DELETE OR UPDATE ON public.payment_events FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

CREATE TRIGGER payment_events_maker AFTER INSERT ON public.payment_events FOR EACH ROW EXECUTE FUNCTION public.record_payment_maker();

CREATE TRIGGER payment_events_no_truncate BEFORE TRUNCATE ON public.payment_events FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

CREATE TRIGGER payment_makers_append_only BEFORE DELETE OR UPDATE ON public.payment_makers FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

CREATE TRIGGER payment_makers_no_truncate BEFORE TRUNCATE ON public.payment_makers FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

CREATE CONSTRAINT TRIGGER payment_posting_required AFTER INSERT OR UPDATE ON public.payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_payment_posting();

CREATE TRIGGER payments_guard BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.guard_payment_change();

CREATE TRIGGER payments_maker AFTER INSERT ON public.payments FOR EACH ROW EXECUTE FUNCTION public.record_payment_maker();

CREATE TRIGGER payments_void_approvals AFTER UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.void_edited_approvals();

CREATE TRIGGER users_void_approvals AFTER UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.void_pending_approvals();

CREATE TRIGGER webhook_inbox_append_only BEFORE DELETE OR UPDATE ON public.webhook_inbox FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

CREATE TRIGGER webhook_inbox_no_truncate BEFORE TRUNCATE ON public.webhook_inbox FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();
