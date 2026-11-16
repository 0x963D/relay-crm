import type { RecordScope } from "@relay/domain";

interface ScopeFilter {
  readonly AND?: ScopeFilter[];
  readonly OR?: ScopeFilter[];
  readonly id?: { in: string[] };
  readonly ownerId?: string;
  readonly teamId?: string;
  readonly status?: "new";
}

export function scopeWhere(scope: RecordScope): ScopeFilter {
  switch (scope.kind) {
    case "intersection":
      return { AND: scope.scopes.map(scopeWhere) };
    case "all":
      return {};
    case "own":
      return { ownerId: scope.userId };
    case "team":
      return { teamId: scope.teamId };
    case "teamAndPool":
      return { OR: [{ teamId: scope.teamId }, { status: "new" }] };
    case "none":
      return { id: { in: [] } };
  }
}
