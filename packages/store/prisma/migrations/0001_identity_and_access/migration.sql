CREATE TYPE public.role AS ENUM (
    'owner',
    'admin',
    'manager',
    'teamLead',
    'agent',
    'accountant'
);

CREATE TYPE public.team_kind AS ENUM (
    'sales',
    'accounts'
);

CREATE TABLE public.auth_accounts (
    id uuid NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id uuid NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp(3) with time zone,
    refresh_token_expires_at timestamp(3) with time zone,
    scope text,
    password text,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.auth_request_limits (
    key text NOT NULL,
    count integer NOT NULL,
    started_at timestamp(3) with time zone NOT NULL,
    window_seconds integer DEFAULT 60 NOT NULL,
    CONSTRAINT auth_request_limits_count_check CHECK ((count > 0)),
    CONSTRAINT auth_request_limits_window_seconds_check CHECK ((window_seconds > 0))
);

CREATE TABLE public.auth_sessions (
    id uuid NOT NULL,
    token text NOT NULL,
    user_id uuid NOT NULL,
    current_team_id uuid,
    expires_at timestamp(3) with time zone NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ip_address text,
    user_agent text
);

CREATE TABLE public.auth_verifications (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp(3) with time zone NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.memberships (
    user_id uuid NOT NULL,
    team_id uuid NOT NULL,
    is_lead boolean DEFAULT false NOT NULL
);

CREATE TABLE public.teams (
    id uuid NOT NULL,
    name text NOT NULL,
    kind public.team_kind NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.users (
    id uuid NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    role public.role NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    role_version integer DEFAULT 0 NOT NULL,
    CONSTRAINT users_role_version_check CHECK ((role_version >= 0))
);

CREATE FUNCTION public.bump_role_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.role_version := OLD.role_version + CASE WHEN NEW.role IS DISTINCT FROM OLD.role THEN 1 ELSE 0 END;
  RETURN NEW;
END $$;

CREATE FUNCTION public.reject_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$$;

ALTER TABLE ONLY public.auth_accounts
    ADD CONSTRAINT auth_accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.auth_request_limits
    ADD CONSTRAINT auth_request_limits_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_token_key UNIQUE (token);

ALTER TABLE ONLY public.auth_verifications
    ADD CONSTRAINT auth_verifications_identifier_key UNIQUE (identifier);

ALTER TABLE ONLY public.auth_verifications
    ADD CONSTRAINT auth_verifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (user_id, team_id);

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

CREATE INDEX auth_accounts_user_id_idx ON public.auth_accounts USING btree (user_id);

CREATE INDEX auth_request_limits_started_at_idx ON public.auth_request_limits USING btree (started_at);

CREATE INDEX auth_sessions_user_id_idx ON public.auth_sessions USING btree (user_id);

CREATE INDEX memberships_team_id_idx ON public.memberships USING btree (team_id);

CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email);

CREATE UNIQUE INDEX users_email_lower_key ON public.users USING btree (lower(email));

ALTER TABLE ONLY public.auth_accounts
    ADD CONSTRAINT auth_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_current_team_id_fkey FOREIGN KEY (current_team_id) REFERENCES public.teams(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

CREATE TRIGGER users_role_version BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.bump_role_version();
