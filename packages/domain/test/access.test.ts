import { describe, expect, it } from "vitest";
import {
  leadScope,
  ROLES,
  scopeAdmits,
  type Actor,
  type LeadScope,
  type LeadState,
  type Role,
} from "../src/index.ts";
import { ALL_STATES, ana, anaOnOtherTeam, ben, describeState } from "./fixtures.ts";

const me = ana.ownerId;
const myTeam = ana.teamId;

const TEAMS = {
  "no team": null,
  "a sales team they lead": { id: myTeam, kind: "sales", isLead: true },
  "a sales team they belong to": { id: myTeam, kind: "sales", isLead: false },
  "an accounts team they lead": { id: myTeam, kind: "accounts", isLead: true },
  "an accounts team they belong to": { id: myTeam, kind: "accounts", isLead: false },
} as const satisfies Record<string, Actor["team"]>;

type TeamSituation = keyof typeof TEAMS;
const SITUATIONS: readonly TeamSituation[] = [
  "no team",
  "a sales team they lead",
  "a sales team they belong to",
  "an accounts team they lead",
  "an accounts team they belong to",
];

const all: LeadScope = { kind: "all" };
const own: LeadScope = { kind: "own", userId: me };
const none: LeadScope = { kind: "none" };
const teamAndPool: LeadScope = { kind: "teamAndPool", teamId: myTeam };

interface Expected {
  readonly read: LeadScope;
  readonly edit: LeadScope;
}
const everywhere = (expected: Expected): Readonly<Record<TeamSituation, Expected>> => ({
  "no team": expected,
  "a sales team they lead": expected,
  "a sales team they belong to": expected,
  "an accounts team they lead": expected,
  "an accounts team they belong to": expected,
});

const EXPECTED: Readonly<Record<Role, Readonly<Record<TeamSituation, Expected>>>> = {
  owner: everywhere({ read: all, edit: all }),
  admin: everywhere({ read: all, edit: all }),
  manager: everywhere({ read: all, edit: all }),
  teamLead: {
    ...everywhere({ read: own, edit: own }),
    "a sales team they lead": { read: teamAndPool, edit: own },
  },
  agent: everywhere({ read: own, edit: own }),
  accountant: everywhere({ read: none, edit: none }),
};

const CASES = ROLES.flatMap((role) =>
  SITUATIONS.map((situation) => ({
    role,
    situation,
    actor: { userId: me, role, team: TEAMS[situation] } satisfies Actor,
    expected: EXPECTED[role][situation],
  })),
);

describe("leadScope", () => {
  it.each(CASES)("gives a $role in $situation the expected scopes", ({ actor, expected }) => {
    expect(leadScope(actor, "read")).toEqual(expected.read);
    expect(leadScope(actor, "edit")).toEqual(expected.edit);
  });

  it.each(CASES)("never lets a $role in $situation edit a lead they cannot read", ({ actor }) => {
    const read = leadScope(actor, "read");
    const edit = leadScope(actor, "edit");
    for (const state of ALL_STATES) {
      if (scopeAdmits(edit, state)) {
        expect(scopeAdmits(read, state), describeState(state)).toBe(true);
      }
    }
  });
});

describe("scopeAdmits", () => {
  const mine: LeadState = { status: "assigned", assignee: ana };
  const teammates: LeadState = { status: "assigned", assignee: ben };
  const mineOnAnotherTeam: LeadState = { status: "assigned", assignee: anaOnOtherTeam };
  const pooled: LeadState = { status: "new" };
  const deadInPool: LeadState = { status: "dead", assignee: null, reason: "duplicate" };
  const closedByTeammate: LeadState = { status: "lost", assignee: ben, reason: "noBudget" };

  it.each<[string, LeadScope, readonly LeadState[], readonly LeadState[]]>([
    ["all", all, [mine, teammates, mineOnAnotherTeam, pooled, deadInPool, closedByTeammate], []],
    ["none", none, [], [mine, teammates, mineOnAnotherTeam, pooled, deadInPool, closedByTeammate]],
    ["own", own, [mine, mineOnAnotherTeam], [teammates, pooled, deadInPool, closedByTeammate]],
    [
      "teamAndPool",
      teamAndPool,
      [mine, teammates, pooled, closedByTeammate],
      [mineOnAnotherTeam, deadInPool],
    ],
  ])("%s admits and excludes the right leads", (_kind, scope, admitted, excluded) => {
    expect(admitted.filter((state) => !scopeAdmits(scope, state))).toEqual([]);
    expect(excluded.filter((state) => scopeAdmits(scope, state))).toEqual([]);
  });
});
