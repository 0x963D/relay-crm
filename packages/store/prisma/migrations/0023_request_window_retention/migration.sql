ALTER TABLE auth_request_limits ADD COLUMN window_seconds integer NOT NULL DEFAULT 60 CHECK (window_seconds>0);
CREATE INDEX auth_request_limits_started_at_idx ON auth_request_limits(started_at);
