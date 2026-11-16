import type { AccountId, TeamId, UserId } from "./ids.ts";

export interface Account {
  readonly id: AccountId;
  readonly ownerId: UserId | null;
  readonly teamId: TeamId | null;
  readonly createdAt: Date;
}

export type RecordKind = "lead" | "account" | "payment" | "ledger";
export type RecordAccess =
  | "read"
  | "edit"
  | "assign"
  | "identity"
  | "reopen"
  | "settle"
  | "reconcile"
  | "closeReview"
  | "approve"
  | "requeueReceipt";
export type RecordScope =
  | { readonly kind: "intersection"; readonly scopes: readonly RecordScope[] }
  | { readonly kind: "all" }
  | { readonly kind: "teamAndPool"; readonly teamId: TeamId }
  | { readonly kind: "team"; readonly teamId: TeamId }
  | { readonly kind: "own"; readonly userId: UserId }
  | { readonly kind: "none" };
