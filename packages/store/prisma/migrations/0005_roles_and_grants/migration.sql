REVOKE USAGE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO relay_app;

GRANT SELECT,INSERT ON TABLE public.accounts TO relay_app;

GRANT SELECT,INSERT ON TABLE public.activities TO relay_app;

GRANT USAGE ON SEQUENCE public.activities_sequence_seq TO relay_app;

GRANT SELECT,INSERT ON TABLE public.audit_log TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.auth_accounts TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.auth_request_limits TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.auth_sessions TO relay_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.auth_verifications TO relay_app;

GRANT SELECT,INSERT ON TABLE public.distribution_previews TO relay_app;

GRANT SELECT ON TABLE public.email_suppressions TO relay_app;

GRANT SELECT,INSERT ON TABLE public.idempotency_records TO relay_app;

GRANT SELECT,INSERT ON TABLE public.intake_events TO relay_app;

GRANT SELECT,INSERT,UPDATE ON TABLE public.leads TO relay_app;

GRANT SELECT,INSERT ON TABLE public.ledger_accounts TO relay_app;

GRANT SELECT,INSERT ON TABLE public.ledger_lines TO relay_app;

GRANT SELECT,INSERT ON TABLE public.ledger_transactions TO relay_app;

GRANT SELECT ON TABLE public.memberships TO relay_app;

GRANT SELECT,INSERT ON TABLE public.outbox TO relay_app;

GRANT UPDATE(state) ON TABLE public.outbox TO relay_app;

GRANT UPDATE(lease_token) ON TABLE public.outbox TO relay_app;

GRANT UPDATE(lease_until) ON TABLE public.outbox TO relay_app;

GRANT UPDATE(next_attempt_at) ON TABLE public.outbox TO relay_app;

GRANT UPDATE(cycle_attempts) ON TABLE public.outbox TO relay_app;

GRANT SELECT,INSERT ON TABLE public.payment_approvals TO relay_app;

GRANT UPDATE(voided_at) ON TABLE public.payment_approvals TO relay_app;

GRANT SELECT,INSERT ON TABLE public.payment_events TO relay_app;

GRANT USAGE ON SEQUENCE public.payment_events_sequence_seq TO relay_app;

GRANT SELECT,INSERT ON TABLE public.payment_makers TO relay_app;

GRANT SELECT,INSERT,UPDATE ON TABLE public.payments TO relay_app;

GRANT SELECT,INSERT ON TABLE public.receipt_attempts TO relay_app;

GRANT UPDATE(state) ON TABLE public.receipt_attempts TO relay_app;

GRANT UPDATE(reason) ON TABLE public.receipt_attempts TO relay_app;

GRANT UPDATE(finished_at) ON TABLE public.receipt_attempts TO relay_app;

GRANT SELECT,INSERT,UPDATE ON TABLE public.sandbox_checkouts TO relay_app;

GRANT SELECT ON TABLE public.teams TO relay_app;

GRANT SELECT,INSERT,UPDATE ON TABLE public.users TO relay_app;

GRANT SELECT,INSERT ON TABLE public.webhook_inbox TO relay_app;
