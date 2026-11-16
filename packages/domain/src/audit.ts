import type { AccountId, LeadId, PaymentId, LedgerTransactionId } from "./ids.ts";

export const AUDIT_ACTIONS = [
  "leadAssigned",
  "leadReopened",
  "checkoutCreated",
  "paymentStateChanged",
  "paymentReviewClosed",
  "ledgerPosted",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type AuditSubject =
  | { readonly type: "lead"; readonly id: LeadId }
  | { readonly type: "account"; readonly id: AccountId }
  | { readonly type: "payment"; readonly id: PaymentId }
  | { readonly type: "ledger"; readonly id: LedgerTransactionId };
export type AuditCause =
  | { readonly kind: "request"; readonly id: string }
  | { readonly kind: "idempotency"; readonly id: string };
