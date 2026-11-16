export const APPEND_ONLY_TABLES = [
  ["activities", "id", "0002_leads_and_intake"],
  ["audit_log", "id", "0002_leads_and_intake"],
  ["distribution_previews", "id", "0002_leads_and_intake"],
  ["idempotency_records", "id", "0002_leads_and_intake"],
  ["intake_events", "id", "0002_leads_and_intake"],
  ["ledger_accounts", "id", "0003_payments_and_ledger"],
  ["ledger_lines", "id", "0003_payments_and_ledger"],
  ["ledger_transactions", "id", "0003_payments_and_ledger"],
  ["payment_events", "sequence", "0003_payments_and_ledger"],
  ["payment_makers", "payment_id", "0003_payments_and_ledger"],
  ["webhook_inbox", "event_id", "0003_payments_and_ledger"],
] as const;
