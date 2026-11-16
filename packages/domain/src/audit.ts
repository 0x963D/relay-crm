import type { AccountId, LeadId } from "./ids.ts";

export const AUDIT_ACTIONS = ["leadAssigned", "leadReopened"] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type AuditSubject =
  | { readonly type: "lead"; readonly id: LeadId }
  | { readonly type: "account"; readonly id: AccountId };
export type AuditCause =
  | { readonly kind: "request"; readonly id: string }
  | { readonly kind: "idempotency"; readonly id: string };
