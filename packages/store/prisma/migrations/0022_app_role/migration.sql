REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO relay_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM relay_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM relay_app;
GRANT SELECT, INSERT ON activities, intake_events, audit_log, distribution_previews, idempotency_records,
  ledger_accounts, ledger_transactions, ledger_lines, payment_events, webhook_inbox TO relay_app;
GRANT SELECT, INSERT, UPDATE ON users, teams, accounts, leads, payments, outbox, sandbox_checkouts,
  payment_approvals, receipt_attempts TO relay_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships, auth_sessions, auth_accounts, auth_verifications,
  auth_request_limits, email_suppressions TO relay_app;
GRANT USAGE ON SEQUENCE payment_events_sequence_seq TO relay_app;
