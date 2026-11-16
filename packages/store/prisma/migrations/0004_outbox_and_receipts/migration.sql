CREATE TABLE public.email_suppressions (
    email text NOT NULL,
    reason text NOT NULL,
    created_at timestamp(3) with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_suppressions_email_check CHECK ((email = lower(btrim(email)))),
    CONSTRAINT email_suppressions_reason_check CHECK ((length(btrim(reason)) > 0))
);

CREATE TABLE public.outbox (
    id uuid NOT NULL,
    payment_id uuid NOT NULL,
    topic text NOT NULL,
    recipient text,
    payload jsonb NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    cycle_attempts integer DEFAULT 0 NOT NULL,
    lease_token uuid,
    created_at timestamp(3) with time zone NOT NULL,
    next_attempt_at timestamp(3) with time zone,
    lease_until timestamp(3) with time zone,
    CONSTRAINT outbox_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT outbox_check CHECK (((lease_token IS NULL) = (lease_until IS NULL))),
    CONSTRAINT outbox_cycle_attempts_check CHECK (((cycle_attempts >= 0) AND (cycle_attempts <= 4))),
    CONSTRAINT outbox_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT outbox_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'sent'::text, 'suppressed'::text, 'failed'::text, 'unknown'::text]))),
    CONSTRAINT outbox_topic_check CHECK ((topic = 'paymentCompleted'::text))
);

CREATE TABLE public.receipt_attempts (
    id uuid NOT NULL,
    outbox_id uuid NOT NULL,
    number integer NOT NULL,
    state text NOT NULL,
    reason text,
    started_at timestamp(3) with time zone NOT NULL,
    finished_at timestamp(3) with time zone,
    CONSTRAINT receipt_attempts_number_check CHECK ((number >= 0)),
    CONSTRAINT receipt_attempts_state_check CHECK ((state = ANY (ARRAY['sent'::text, 'suppressed'::text, 'failed'::text, 'unknown'::text])))
);

CREATE FUNCTION public.check_payment_outbox() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM payments p WHERE p.id=NEW.id AND p.status='completed' AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.payment_id=p.id)) THEN
    RAISE EXCEPTION 'Completed payment requires a receipt row' USING ERRCODE='23514', CONSTRAINT='payment_outbox_required';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION public.count_receipt_attempt() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $_$
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
$_$;

CREATE FUNCTION public.guard_outbox_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.id,NEW.payment_id,NEW.topic) IS DISTINCT FROM (OLD.id,OLD.payment_id,OLD.topic) THEN
    RAISE EXCEPTION 'Receipt identity is immutable' USING ERRCODE='23001';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.guard_receipt_attempt() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.finished_at IS NOT NULL OR NEW.finished_at IS NULL OR
    (NEW.id,NEW.outbox_id,NEW.number,NEW.started_at) IS DISTINCT FROM (OLD.id,OLD.outbox_id,OLD.number,OLD.started_at)
  THEN RAISE EXCEPTION 'A finished receipt attempt is immutable' USING ERRCODE='23001'; END IF;
  RETURN NEW;
END $$;

ALTER TABLE ONLY public.email_suppressions
    ADD CONSTRAINT email_suppressions_pkey PRIMARY KEY (email);

ALTER TABLE ONLY public.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.receipt_attempts
    ADD CONSTRAINT receipt_attempts_outbox_id_number_key UNIQUE (outbox_id, number);

ALTER TABLE ONLY public.receipt_attempts
    ADD CONSTRAINT receipt_attempts_pkey PRIMARY KEY (id);

CREATE INDEX outbox_due_idx ON public.outbox USING btree (next_attempt_at) WHERE (state = ANY (ARRAY['pending'::text, 'failed'::text]));

CREATE UNIQUE INDEX outbox_payment_id_key ON public.outbox USING btree (payment_id);

ALTER TABLE ONLY public.outbox
    ADD CONSTRAINT outbox_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id);

ALTER TABLE ONLY public.receipt_attempts
    ADD CONSTRAINT receipt_attempts_outbox_id_fkey FOREIGN KEY (outbox_id) REFERENCES public.outbox(id);

CREATE TRIGGER outbox_identity BEFORE UPDATE ON public.outbox FOR EACH ROW EXECUTE FUNCTION public.guard_outbox_identity();

CREATE TRIGGER outbox_no_delete BEFORE DELETE ON public.outbox FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

CREATE TRIGGER outbox_no_truncate BEFORE TRUNCATE ON public.outbox FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

CREATE CONSTRAINT TRIGGER payment_outbox_required AFTER INSERT OR UPDATE ON public.payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_payment_outbox();

CREATE TRIGGER receipt_attempt_counter AFTER INSERT ON public.receipt_attempts FOR EACH ROW EXECUTE FUNCTION public.count_receipt_attempt();

CREATE TRIGGER receipt_attempts_guard BEFORE UPDATE ON public.receipt_attempts FOR EACH ROW EXECUTE FUNCTION public.guard_receipt_attempt();

CREATE TRIGGER receipt_attempts_no_delete BEFORE DELETE ON public.receipt_attempts FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

CREATE TRIGGER receipt_attempts_no_truncate BEFORE TRUNCATE ON public.receipt_attempts FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();
