import type { TeamId, UserId } from "./ids.ts";
import { assigneeOf, type LeadState } from "./lead.ts";

export const ROLES = ["owner", "admin", "manager", "teamLead", "agent", "accountant"] as const;
export type Role = (typeof ROLES)[number];

export const TEAM_KINDS = ["sales", "accounts"] as const;
export type TeamKind = (typeof TEAM_KINDS)[number];

/** A session works inside one current team, or none. */
export interface Actor {
  readonly userId: UserId;
  readonly role: Role;
  readonly team: {
    readonly id: TeamId;
    readonly kind: TeamKind;
    readonly isLead: boolean;
  } | null;
}

/** The pool is every lead with status `new`. */
export type LeadScope =
  | { readonly kind: "all" }
  | { readonly kind: "teamAndPool"; readonly teamId: TeamId }
  | { readonly kind: "own"; readonly userId: UserId }
  | { readonly kind: "none" };

export type LeadAccess = "read" | "edit";

/**
 * The one function that decides which leads an actor may read or edit. Role is the ceiling:
 * leading a sales team widens what a team lead reads, and widens nothing for any other role.
 * Edit is never wider than read.
 */
export function leadScope(actor: Actor, access: LeadAccess): LeadScope {
  switch (actor.role) {
    case "owner":
    case "admin":
    case "manager":
      return { kind: "all" };
    case "teamLead":
      return access === "read" && actor.team?.kind === "sales" && actor.team.isLead
        ? { kind: "teamAndPool", teamId: actor.team.id }
        : { kind: "own", userId: actor.userId };
    case "agent":
      return { kind: "own", userId: actor.userId };
    case "accountant":
      return { kind: "none" };
  }
}

/** The in-memory reading of a scope, for re-checking a lead inside the transaction that edits it. */
export function scopeAdmits(scope: LeadScope, state: LeadState): boolean {
  switch (scope.kind) {
    case "all":
      return true;
    case "teamAndPool":
      return state.status === "new" || assigneeOf(state)?.teamId === scope.teamId;
    case "own":
      return assigneeOf(state)?.ownerId === scope.userId;
    case "none":
      return false;
  }
}
