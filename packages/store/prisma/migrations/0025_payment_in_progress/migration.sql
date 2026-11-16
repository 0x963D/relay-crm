DROP INDEX payments_pending_account_key;
CREATE UNIQUE INDEX payments_in_progress_account_key ON payments(account_id) WHERE status IN ('pendingApproval','checkoutCreated');
