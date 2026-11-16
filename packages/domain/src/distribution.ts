import type { LeadId, UserId } from "./ids.ts";
import type { Assignment, LeadLifecycle } from "./lead.ts";

export interface DistributionRequest {
  readonly leadIds: readonly LeadId[];
  readonly agents: readonly Assignment[];
  readonly excludePreviousOwner: boolean;
}

export interface DistributionItem {
  readonly leadId: LeadId;
  readonly to: Assignment;
}

export interface DistributionPreview {
  readonly id: string;
  readonly fingerprint: string;
  readonly items: readonly DistributionItem[];
}

export interface DistributionResult {
  readonly changed: boolean;
  readonly items: readonly DistributionItem[];
}

export interface DistributionLead {
  readonly id: LeadId;
  readonly version: number;
  readonly lifecycle: LeadLifecycle;
}

export const ACCESS_FAILURES = [
  "leadClosed",
  "callbackInPast",
  "wrongNumberNeedsAnAttempt",
  "invalidTransition",
  "pendingPayment",
  "receiptUsed",
  "receiptAttemptLimit",
  "paymentRecorder",
  "paymentMaker",
  "alreadyApproved",
  "roleChanged",
  "refreshConflict",
  "accessDenied",
  "conflict",
  "idempotencyConflict",
  "teamSelectionRequired",
  "stalePreview",
  "invalidAgent",
  "noEligibleAgent",
] as const;
export type AccessFailure = (typeof ACCESS_FAILURES)[number];

export interface DistributionReceipt {
  readonly actorId: UserId;
  readonly preview: DistributionPreview;
  readonly leads: readonly DistributionLead[];
}
