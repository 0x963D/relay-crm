CREATE TABLE job_leases (
    route text PRIMARY KEY CHECK (route IN ('outbox','reconcile')),
    token uuid NOT NULL,
    expires_at timestamp(3) with time zone NOT NULL
);

GRANT SELECT,INSERT,UPDATE ON job_leases TO relay_app;
