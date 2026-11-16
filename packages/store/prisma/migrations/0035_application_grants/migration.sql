REVOKE INSERT,UPDATE ON teams FROM relay_app;
REVOKE INSERT,UPDATE,DELETE ON email_suppressions,memberships FROM relay_app;
REVOKE UPDATE ON accounts,receipt_attempts,payment_approvals FROM relay_app;
GRANT UPDATE(state,reason,finished_at) ON receipt_attempts TO relay_app;
GRANT UPDATE(voided_at) ON payment_approvals TO relay_app;
