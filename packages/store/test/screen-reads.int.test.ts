import { describe, expect } from "vitest";
import { UserId } from "@relay/domain";
import { test } from "../src/testing/index.ts";

for (const role of ["manager", "teamLead", "agent", "accountant"] as const) {
  describe(role, () => {
    test("the screen reads retain scope and return only assignable agents", async ({ db }) => {
      const userId = await db.seedUser(role);
      const agentId = await db.seedUser("agent");
      const outsideId = await db.seedUser("agent");
      const sales = await db.seedTeam("sales");
      const other = await db.seedTeam("sales");
      await db.ownerRows(
        "INSERT INTO memberships(user_id,team_id,is_lead) VALUES ($1,$4,true),($2,$4,false),($3,$5,false)",
        [userId, agentId, outsideId, sales, other],
      );
      const actor = { userId, role, team: { id: sales, kind: "sales" as const, isLead: true } };
      const pool = await db.seedLead({
        email: "pool@example.com",
        lifecycle: { state: { status: "new" }, firstAssignedAt: null, previousOwnerId: agentId },
      });
      const own = await db.seedLead({
        email: "owned@example.com",
        lifecycle: {
          state: { status: "assigned", assignee: { ownerId: agentId, teamId: sales } },
          firstAssignedAt: new Date(),
          previousOwnerId: null,
        },
      });
      await db.seedLead({
        email: "outside@example.com",
        lifecycle: {
          state: { status: "assigned", assignee: { ownerId: outsideId, teamId: other } },
          firstAssignedAt: new Date(),
          previousOwnerId: null,
        },
      });
      const profile = await db.store.sessionProfile(actor);
      expect(profile.userId).toBe(userId);
      expect(profile.name).toBeTruthy();
      if (role === "agent" || role === "accountant") {
        await expect(db.store.leadPool(actor, { limit: 14, offset: 0 })).rejects.toMatchObject({
          code: "accessDenied",
        });
      } else {
        const page = await db.store.leadPool(actor, { limit: 1, offset: 0 });
        expect(page.total).toBe(1);
        expect(page.rows[0]).toMatchObject({ id: pool, previousOwner: { id: agentId } });
        expect((await db.store.leadPool(actor, { limit: 1, offset: 1 })).rows).toEqual([]);
      }
      if (role === "accountant") {
        await expect(db.store.queueAgents(actor, 0)).rejects.toMatchObject({
          code: "accessDenied",
        });
      } else {
        const agents = await db.store.queueAgents(actor, 0);
        expect(agents.every((a) => UserId.parse(a.ownerId) !== null)).toBe(true);
        expect(agents.find((a) => a.ownerId === outsideId) !== undefined).toBe(role === "manager");
        if (role !== "agent") expect(agents.find((a) => a.ownerId === agentId)?.openCount).toBe(1);
      }
      if (role === "manager" || role === "teamLead") {
        const page = await db.store.workQueue(actor, {
          agentId,
          at: new Date(),
          timeZone: "UTC",
          limit: 1,
          offset: 0,
        });
        expect(page.notYetCalled[0]?.id).toBe(own);
        const next = await db.store.workQueue(actor, {
          agentId,
          at: new Date(),
          timeZone: "UTC",
          limit: 1,
          offset: 1,
        });
        expect(next.notYetCalled).toEqual([]);
        expect(next.counts.notYetCalled).toBe(1);
      }
      await db.rows("UPDATE users SET role='accountant' WHERE id=$1", [userId]);
      await expect(db.store.leadPool(actor, { limit: 14, offset: 0 })).rejects.toMatchObject({
        code: "accessDenied",
      });
      await expect(db.store.queueAgents(actor, 0)).rejects.toMatchObject({ code: "accessDenied" });
    });
  });
}
