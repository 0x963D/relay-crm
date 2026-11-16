CREATE TYPE public.activity_kind AS ENUM (
    'intake',
    'statusChange',
    'assignment',
    'attempt',
    'note',
    'callback',
    'closure'
);

CREATE TYPE public.audit_action AS ENUM (
    'leadAssigned',
    'leadReopened',
    'checkoutCreated',
    'paymentStateChanged',
    'paymentReviewClosed',
    'ledgerPosted',
    'manualPaymentRecorded',
    'paymentApproved',
    'paymentEdited',
    'receiptRequeued',
    'leadWorked'
);

CREATE TYPE public.audit_subject_type AS ENUM (
    'lead',
    'account',
    'payment',
    'ledger'
);

CREATE TYPE public.dead_reason AS ENUM (
    'duplicate',
    'wrongNumber',
    'doNotContact'
);

CREATE TYPE public.intake_outcome AS ENUM (
    'leadCreated',
    'attachedToOpenLead',
    'leadReopened',
    'linkedToAccount',
    'suppressedDeadLead',
    'rejectedNoEmail'
);

CREATE TYPE public.intake_source AS ENUM (
    'metaLeadAds',
    'webForm',
    'csv',
    'manual'
);

CREATE TYPE public.lead_status AS ENUM (
    'new',
    'assigned',
    'working',
    'won',
    'lost',
    'dead'
);

CREATE TYPE public.system_actor AS ENUM (
    'intake',
    'providerWebhook',
    'reconciler'
);

CREATE TYPE public.work_stage AS ENUM (
    'contacted',
    'callBack',
    'noAnswer',
    'ready'
);

CREATE SEQUENCE public.activities_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE public.accounts (
    id uuid NOT NULL,
    owner_id uuid,
    team_id uuid,
    created_at timestamp(3) with time zone NOT NULL
);

CREATE TABLE public.activities (
    id uuid NOT NULL,
    sequence bigint DEFAULT nextval('public.activities_sequence_seq'::regclass) NOT NULL,
    lead_id uuid,
    account_id uuid,
    intake_event_id uuid,
    kind public.activity_kind NOT NULL,
    detail jsonb,
    at timestamp(3) with time zone NOT NULL,
    CONSTRAINT activities_intake_ref CHECK (((kind = 'intake'::public.activity_kind) = (intake_event_id IS NOT NULL))),
    CONSTRAINT activities_one_subject CHECK ((num_nonnulls(lead_id, account_id) = 1))
);

CREATE TABLE public.audit_log (
    id uuid NOT NULL,
    subject_type public.audit_subject_type NOT NULL,
    subject_id uuid NOT NULL,
    actor_id uuid,
    system_actor public.system_actor,
    request_id uuid NOT NULL,
    idempotency_id uuid,
    action public.audit_action NOT NULL,
    before jsonb NOT NULL,
    after jsonb NOT NULL,
    at timestamp(3) with time zone NOT NULL,
    CONSTRAINT audit_actor_exactly_one CHECK (((((actor_id IS NOT NULL))::integer + ((system_actor IS NOT NULL))::integer) = 1)),
    CONSTRAINT audit_snapshots_objects CHECK (((jsonb_typeof(before) = 'object'::text) AND (jsonb_typeof(after) = 'object'::text) AND ((NOT (before ? 'lifecycle'::text)) OR (jsonb_typeof((before -> 'lifecycle'::text)) = 'object'::text)) AND ((NOT (after ? 'lifecycle'::text)) OR (jsonb_typeof((after -> 'lifecycle'::text)) = 'object'::text))))
);

CREATE TABLE public.distribution_previews (
    id uuid NOT NULL,
    actor_id uuid NOT NULL,
    request jsonb NOT NULL,
    snapshot jsonb NOT NULL,
    fingerprint text NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.idempotency_records (
    id uuid NOT NULL,
    scope text NOT NULL,
    key text NOT NULL,
    operation text NOT NULL,
    request_hash text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT idempotency_result_object CHECK ((jsonb_typeof(result) = 'object'::text))
);

CREATE TABLE public.intake_events (
    id uuid NOT NULL,
    source public.intake_source NOT NULL,
    external_id text NOT NULL,
    lead_id uuid,
    account_id uuid,
    email text,
    name text,
    phone text,
    campaign text,
    ad_set text,
    ad text,
    form text,
    raw json NOT NULL,
    outcome public.intake_outcome NOT NULL,
    submitted_at timestamp(3) with time zone,
    received_at timestamp(3) with time zone NOT NULL,
    CONSTRAINT intake_events_outcome_subject CHECK (
CASE
    WHEN (outcome = 'rejectedNoEmail'::public.intake_outcome) THEN ((lead_id IS NULL) AND (account_id IS NULL))
    WHEN (outcome = 'linkedToAccount'::public.intake_outcome) THEN ((lead_id IS NULL) AND (account_id IS NOT NULL))
    WHEN (outcome = ANY (ARRAY['leadCreated'::public.intake_outcome, 'attachedToOpenLead'::public.intake_outcome, 'leadReopened'::public.intake_outcome, 'suppressedDeadLead'::public.intake_outcome])) THEN ((lead_id IS NOT NULL) AND (account_id IS NULL))
    ELSE false
END)
);

CREATE TABLE public.leads (
    id uuid NOT NULL,
    email text NOT NULL,
    name text,
    phone text,
    owner_id uuid,
    team_id uuid,
    previous_owner_id uuid,
    account_id uuid,
    status public.lead_status NOT NULL,
    stage public.work_stage,
    no_answer_count integer,
    dead_reason public.dead_reason,
    lost_note text,
    version integer DEFAULT 0 NOT NULL,
    created_at timestamp(3) with time zone NOT NULL,
    first_assigned_at timestamp(3) with time zone,
    contacted_at timestamp(3) with time zone,
    call_back_at timestamp(3) with time zone,
    CONSTRAINT leads_email_canonical CHECK (((length(email) <= 254) AND (length(split_part(email, '@'::text, 1)) <= 64) AND (length(split_part(email, '@'::text, 2)) <= 253) AND (email ~ ('^[a-z0-9_!#$%&''*+/=?^`{|}~-]+(\.[a-z0-9_!#$%&''*+/=?^`{|}~-]+)*'::text || '@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(?=[a-z0-9-]*[a-z])[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'::text)))),
    CONSTRAINT leads_owned_was_assigned CHECK (((owner_id IS NULL) OR (first_assigned_at IS NOT NULL))),
    CONSTRAINT leads_stage_shape CHECK (
CASE
    WHEN ((stage IS NULL) OR ((stage)::text = ANY (ARRAY['contacted'::text, 'ready'::text]))) THEN ((call_back_at IS NULL) AND (no_answer_count IS NULL))
    WHEN (stage = 'callBack'::public.work_stage) THEN ((call_back_at IS NOT NULL) AND (no_answer_count IS NULL))
    WHEN (stage = 'noAnswer'::public.work_stage) THEN ((call_back_at IS NULL) AND (no_answer_count IS NOT NULL) AND (no_answer_count >= 1))
    ELSE false
END),
    CONSTRAINT leads_state_shape CHECK ((((owner_id IS NULL) = (team_id IS NULL)) AND ((lost_note IS NULL) OR ((status = 'lost'::public.lead_status) AND (btrim(lost_note) <> ''::text))) AND
CASE status
    WHEN 'new'::public.lead_status THEN ((owner_id IS NULL) AND (stage IS NULL) AND (lost_note IS NULL) AND (dead_reason IS NULL) AND (account_id IS NULL))
    WHEN 'assigned'::public.lead_status THEN ((owner_id IS NOT NULL) AND (stage IS NULL) AND (lost_note IS NULL) AND (dead_reason IS NULL) AND (account_id IS NULL))
    WHEN 'working'::public.lead_status THEN ((owner_id IS NOT NULL) AND (stage IS NOT NULL) AND (lost_note IS NULL) AND (dead_reason IS NULL) AND (account_id IS NULL))
    WHEN 'won'::public.lead_status THEN ((owner_id IS NOT NULL) AND (stage IS NULL) AND (lost_note IS NULL) AND (dead_reason IS NULL) AND (account_id IS NOT NULL))
    WHEN 'lost'::public.lead_status THEN ((owner_id IS NOT NULL) AND (stage IS NULL) AND (lost_note IS NOT NULL) AND (dead_reason IS NULL) AND (account_id IS NULL))
    WHEN 'dead'::public.lead_status THEN ((stage IS NULL) AND (lost_note IS NULL) AND (dead_reason IS NOT NULL) AND (account_id IS NULL))
    ELSE false
END))
);

ALTER SEQUENCE public.activities_sequence_seq OWNED BY public.activities.sequence;

CREATE FUNCTION public.bump_lead_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.version = OLD.version;
  IF NEW IS DISTINCT FROM OLD THEN
    NEW.version = OLD.version + 1;
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION public.guard_lead_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.require_intake_reopening() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_sequence_key UNIQUE (sequence);

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.distribution_previews
    ADD CONSTRAINT distribution_previews_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.idempotency_records
    ADD CONSTRAINT idempotency_records_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.idempotency_records
    ADD CONSTRAINT idempotency_records_scope_key_key UNIQUE (scope, key);

ALTER TABLE ONLY public.intake_events
    ADD CONSTRAINT intake_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_pkey PRIMARY KEY (id);

CREATE INDEX accounts_owner_id_idx ON public.accounts USING btree (owner_id);

CREATE INDEX activities_account_id_id_idx ON public.activities USING btree (account_id, id);

CREATE INDEX activities_intake_event_id_idx ON public.activities USING btree (intake_event_id);

CREATE INDEX activities_lead_id_id_idx ON public.activities USING btree (lead_id, id);

CREATE INDEX audit_log_idempotency_id_idx ON public.audit_log USING btree (idempotency_id);

CREATE INDEX audit_log_request_id_idx ON public.audit_log USING btree (request_id);

CREATE INDEX audit_log_subject_id_id_idx ON public.audit_log USING btree (subject_id, id);

CREATE INDEX intake_events_account_id_idx ON public.intake_events USING btree (account_id);

CREATE INDEX intake_events_lead_id_idx ON public.intake_events USING btree (lead_id);

CREATE UNIQUE INDEX intake_events_source_external_id_key ON public.intake_events USING btree (source, external_id);

CREATE UNIQUE INDEX leads_account_id_key ON public.leads USING btree (account_id);

CREATE INDEX leads_created_at_id_idx ON public.leads USING btree (created_at, id);

CREATE UNIQUE INDEX leads_email_key ON public.leads USING btree (email);

CREATE INDEX leads_owner_id_created_at_id_idx ON public.leads USING btree (owner_id, created_at, id);

CREATE INDEX leads_team_id_created_at_id_idx ON public.leads USING btree (team_id, created_at, id);

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_intake_event_id_fkey FOREIGN KEY (intake_event_id) REFERENCES public.intake_events(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_idempotency_id_fkey FOREIGN KEY (idempotency_id) REFERENCES public.idempotency_records(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.distribution_previews
    ADD CONSTRAINT distribution_previews_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.intake_events
    ADD CONSTRAINT intake_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.intake_events
    ADD CONSTRAINT intake_events_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_previous_owner_id_fkey FOREIGN KEY (previous_owner_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE TRIGGER activities_append_only BEFORE DELETE OR UPDATE ON public.activities FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

CREATE TRIGGER activities_no_truncate BEFORE TRUNCATE ON public.activities FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

CREATE TRIGGER audit_log_append_only BEFORE DELETE OR UPDATE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON public.audit_log FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

CREATE TRIGGER distribution_previews_append_only BEFORE DELETE OR UPDATE ON public.distribution_previews FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

CREATE TRIGGER distribution_previews_no_truncate BEFORE TRUNCATE ON public.distribution_previews FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

CREATE TRIGGER idempotency_records_append_only BEFORE DELETE OR UPDATE ON public.idempotency_records FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

CREATE TRIGGER idempotency_records_no_truncate BEFORE TRUNCATE ON public.idempotency_records FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

CREATE TRIGGER intake_events_append_only BEFORE DELETE OR UPDATE ON public.intake_events FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

CREATE TRIGGER intake_events_no_truncate BEFORE TRUNCATE ON public.intake_events FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

CREATE CONSTRAINT TRIGGER leads_intake_reopening AFTER UPDATE ON public.leads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((old.status = 'lost'::public.lead_status) AND (new.status = 'new'::public.lead_status))) EXECUTE FUNCTION public.require_intake_reopening();

CREATE TRIGGER leads_transition BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.guard_lead_transition();

CREATE TRIGGER leads_version BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.bump_lead_version();
