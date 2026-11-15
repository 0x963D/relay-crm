ALTER TYPE activity_kind ADD VALUE 'assignment';
ALTER TABLE users
  ADD COLUMN email_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN image text,
  ADD COLUMN updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE accounts ADD COLUMN team_id uuid REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN version integer NOT NULL DEFAULT 0;

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  token text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
  expires_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip_address text,
  user_agent text
);
CREATE INDEX auth_sessions_user_id_idx ON auth_sessions(user_id);
CREATE TABLE auth_accounts (
  id uuid PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz(3),
  refresh_token_expires_at timestamptz(3),
  scope text,
  password text,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX auth_accounts_user_id_idx ON auth_accounts(user_id);
CREATE TABLE auth_verifications (
  id uuid PRIMARY KEY,
  identifier text NOT NULL UNIQUE,
  value text NOT NULL,
  expires_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE auth_request_limits (
  key text PRIMARY KEY,
  count integer NOT NULL CHECK (count > 0),
  started_at timestamptz(3) NOT NULL
);
CREATE TABLE distribution_previews (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  fingerprint text NOT NULL,
  request jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE distributions (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  key text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT distributions_actor_id_key_key UNIQUE(actor_id, key)
);
CREATE TABLE audit_log (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action text NOT NULL,
  subject_id uuid NOT NULL,
  before jsonb NOT NULL,
  after jsonb NOT NULL,
  at timestamptz(3) NOT NULL
);
CREATE INDEX audit_log_subject_id_id_idx ON audit_log(subject_id, id);
CREATE FUNCTION bump_lead_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version = OLD.version + 1;
  RETURN NEW;
END
$$;
CREATE TRIGGER leads_version BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION bump_lead_version();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER distributions_append_only BEFORE UPDATE OR DELETE ON distributions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER distribution_previews_append_only BEFORE UPDATE OR DELETE ON distribution_previews
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
