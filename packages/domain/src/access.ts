import type { TeamId, UserId } from "./ids.ts";
import { assigneeOf, type LeadState } from "./lead.ts";
import type { Account, RecordAccess, RecordKind, RecordScope } from "./account.ts";

export const ROLES = ["owner", "admin", "manager", "teamLead", "agent", "accountant"] as const;
export type Role = (typeof ROLES)[number];
export const TEAM_KINDS = ["sales", "accounts"] as const;
export type TeamKind = (typeof TEAM_KINDS)[number];

export interface Actor {
  readonly userId: UserId;
  readonly role: Role;
  readonly team: {
    readonly id: TeamId;
    readonly kind: TeamKind;
    readonly isLead: boolean;
  } | null;
}

export type LeadScope = RecordScope;
export type LeadAccess = RecordAccess;

type Rule = "all" | "own" | "none" | "team";
type Rules = Readonly<Record<RecordKind, Readonly<Record<RecordAccess, Rule>>>>;
const management: Rules = {
  lead: { read: "all", edit: "all", assign: "all" },
  account: { read: "all", edit: "all", assign: "all" },
};
const RULES: Readonly<Record<Role, Rules>> = {
  owner: management,
  admin: management,
  manager: management,
  teamLead: {
    lead: { read: "team", edit: "own", assign: "team" },
    account: { read: "team", edit: "own", assign: "team" },
  },
  agent: {
    lead: { read: "own", edit: "own", assign: "none" },
    account: { read: "own", edit: "own", assign: "none" },
  },
  accountant: {
    lead: { read: "none", edit: "none", assign: "none" },
    account: { read: "all", edit: "none", assign: "none" },
  },
};

export function recordScope(actor: Actor, record: RecordKind, access: RecordAccess): RecordScope {
  const scope: RecordScope = (() => {
    const rule = RULES[actor.role][record][access];
    if (rule === "all" || rule === "none") return { kind: rule };
    if (rule === "team") {
      if (actor.team?.kind === "sales" && actor.team.isLead) {
        return { kind: record === "lead" ? "teamAndPool" : "team", teamId: actor.team.id };
      }
      if (access === "assign") return { kind: "none" };
    }
    return { kind: "own", userId: actor.userId };
  })();
  if (access === "read") return scope;
  const read = recordScope(actor, record, "read");
  if (read.kind === "none" || scope.kind === "none") return { kind: "none" };
  if (read.kind === "all" || read.kind === scope.kind) return scope;
  if (scope.kind === "all") return read;
  return { kind: "intersection", scopes: [scope, read] };
}

export function scopeAdmits(scope: RecordScope, record: LeadState | Account): boolean {
  const owner = "status" in record ? assigneeOf(record) : record;
  switch (scope.kind) {
    case "intersection":
      return scope.scopes.every((part) => scopeAdmits(part, record));
    case "all":
      return true;
    case "teamAndPool":
      return ("status" in record && record.status === "new") || owner?.teamId === scope.teamId;
    case "team":
      return owner?.teamId === scope.teamId;
    case "own":
      return owner !== null && "ownerId" in owner && owner.ownerId === scope.userId;
    case "none":
      return false;
  }
}
