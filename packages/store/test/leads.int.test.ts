import {
  assigneeOf,
  leadScope,
  ROLES,
  scopeAdmits,
  type Actor,
  type Assignment,
  type LeadId,
  type LeadLifecycle,
  type LeadState,
} from "@relay/domain";
import { leadStateExamples } from "@relay/domain/testing";
import { describe, expect } from "vitest";
import { test, type TestDatabase } from "../src/testing/index.ts";

const FIRST_ASSIGNED = new Date("2026-02-01T08:00:00.000Z");
const CALL_BACK = new Date("2026-03-09T14:30:00.000Z");
const EVERYTHING = { limit: 1_000 };

interface Seeded {
  readonly id: LeadId;
  readonly lifecycle: LeadLifecycle;
}

interface World {
  readonly ana: Assignment;
  readonly ben: Assignment;
  readonly cara: Assignment;
  readonly leads: readonly Seeded[];
}

/**
 * Three agents, two of them on one team, and a lead in every example state for each of them.
 * Per agent that is ten leads they hold, one pooled lead and two that died in the pool.
 */
async function seedWorld(db: TestDatabase): Promise<World> {
  const teamA = await db.seedTeam("sales");
  const teamB = await db.seedTeam("sales");
  const ana = { ownerId: await db.seedUser("agent"), teamId: teamA };
  const ben = { ownerId: await db.seedUser("agent"), teamId: teamA };
  const cara = { ownerId: await db.seedUser("agent"), teamId: teamB };

  const leads: Seeded[] = [];
  for (const assignee of [ana, ben, cara]) {
    const examples = leadStateExamples({
      assignee,
      accountId: await db.seedAccount(),
      callBackAt: CALL_BACK,
    });
    const states: readonly LeadState[] = Object.values(examples).flat();
    for (const state of states) {
      const lifecycle: LeadLifecycle = {
        state,
        firstAssignedAt: assigneeOf(state) === null ? null : FIRST_ASSIGNED,
        previousOwnerId: state.status === "new" ? assignee.ownerId : null,
      };
      const id = await db.seedLead({
        email: `lead-${String(leads.length)}@example.com`,
        lifecycle,
      });
      leads.push({ id, lifecycle });
    }
  }
  return { ana, ben, cara, leads };
}

async function ownerOf(db: TestDatabase): Promise<Actor> {
  return { userId: await db.seedUser("owner"), role: "owner", team: null };
}

function byId(leads: readonly Seeded[]): ReadonlyMap<LeadId, LeadLifecycle> {
  return new Map(leads.map((lead) => [lead.id, lead.lifecycle]));
}

describe("lead rows", () => {
  test("every lead state survives a round trip through its columns", async ({ db }) => {
    const world = await seedWorld(db);

    const listed = await db.store.listLeads(await ownerOf(db), EVERYTHING);

    expect(byId(listed)).toEqual(byId(world.leads));
  });
});

describe("listLeads scoping", () => {
  test("selects exactly the leads scopeAdmits accepts, for every kind of actor", async ({ db }) => {
    const world = await seedWorld(db);
    const teams: readonly Actor["team"][] = [
      null,
      { id: world.ana.teamId, kind: "sales", isLead: true },
      { id: world.ana.teamId, kind: "sales", isLead: false },
      { id: world.ana.teamId, kind: "accounts", isLead: true },
      { id: world.cara.teamId, kind: "sales", isLead: true },
    ];

    for (const role of ROLES) {
      for (const team of teams) {
        const actor: Actor = { userId: world.ana.ownerId, role, team };
        const scope = leadScope(actor, "read");
        const admitted = world.leads
          .filter((lead) => scopeAdmits(scope, lead.lifecycle.state))
          .map((lead) => lead.id);

        const listed = await db.store.listLeads(actor, EVERYTHING);

        expect(
          listed.map((lead) => lead.id).sort(),
          `${role} with team ${JSON.stringify(team)}`,
        ).toEqual(admitted.sort());
      }
    }
  });

  test("gives each scope the number of leads the seeded world holds for it", async ({ db }) => {
    const world = await seedWorld(db);
    const count = async (actor: Omit<Actor, "userId">): Promise<number> => {
      const listed = await db.store.listLeads({ userId: world.ana.ownerId, ...actor }, EVERYTHING);
      return listed.length;
    };
    const leadsTeamA = { id: world.ana.teamId, kind: "sales", isLead: true } as const;

    expect(await count({ role: "owner", team: null }), "all").toBe(39);
    expect(await count({ role: "agent", team: leadsTeamA }), "own").toBe(10);
    expect(await count({ role: "teamLead", team: leadsTeamA }), "team and pool").toBe(23);
    expect(await count({ role: "accountant", team: leadsTeamA }), "none").toBe(0);
  });
});

describe("listLeads ordering", () => {
  const pooled: LeadLifecycle = {
    state: { status: "new" },
    firstAssignedAt: null,
    previousOwnerId: null,
  };

  test("lists the newest lead first and stops at the limit", async ({ db }) => {
    const oldest = await db.seedLead({
      email: "oldest@example.com",
      lifecycle: pooled,
      createdAt: new Date("2026-03-01T09:00:00.000Z"),
    });
    const newest = await db.seedLead({
      email: "newest@example.com",
      lifecycle: pooled,
      createdAt: new Date("2026-03-03T09:00:00.000Z"),
    });
    const middle = await db.seedLead({
      email: "middle@example.com",
      lifecycle: pooled,
      createdAt: new Date("2026-03-02T09:00:00.000Z"),
    });
    const owner = await ownerOf(db);

    const all = await db.store.listLeads(owner, EVERYTHING);
    const firstTwo = await db.store.listLeads(owner, { limit: 2 });

    expect(all.map((lead) => lead.id)).toEqual([newest, middle, oldest]);
    expect(firstTwo.map((lead) => lead.id)).toEqual([newest, middle]);
  });

  test("breaks a tie on creation time by the later ID", async ({ db }) => {
    const createdAt = new Date("2026-03-02T09:00:00.000Z");
    const first = await db.seedLead({ email: "first@example.com", lifecycle: pooled, createdAt });
    const second = await db.seedLead({ email: "second@example.com", lifecycle: pooled, createdAt });

    const listed = await db.store.listLeads(await ownerOf(db), EVERYTHING);

    expect(listed.map((lead) => lead.id)).toEqual([second, first].sort().reverse());
  });
});
