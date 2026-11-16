import { submissionExample } from "@relay/domain/testing";
import { ROLES, type Actor, type Assignment, type LeadId, type Role } from "@relay/domain";
import { expect, describe } from "vitest";
import { test, type TestDatabase } from "../src/testing/index.ts";

async function world(db: TestDatabase, role: Role = "manager") {
  const teamId = await db.seedTeam("sales");
  const otherTeamId = await db.seedTeam("sales");
  const userId = await db.seedUser(role);
  const agentId = await db.seedUser("agent");
  const otherId = await db.seedUser("agent");
  for (const [user, team, lead] of [
    [userId, teamId, true],
    [agentId, teamId, false],
    [otherId, otherTeamId, false],
  ] as const) {
    await db.rows("INSERT INTO memberships(user_id, team_id, is_lead) VALUES ($1,$2,$3)", [
      user,
      team,
      lead,
    ]);
  }
  const actor: Actor = { userId, role, team: { id: teamId, kind: "sales", isLead: true } };
  const agent: Assignment = { ownerId: agentId, teamId };
  const other: Assignment = { ownerId: otherId, teamId: otherTeamId };
  const lead = (email: string, assignee: Assignment | null) =>
    db.seedLead({
      email,
      lifecycle: {
        state: assignee === null ? { status: "new" } : { status: "assigned", assignee },
        firstAssignedAt: assignee === null ? null : new Date(),
        previousOwnerId: null,
      },
    });
  const own = await lead("own@example.com", { ownerId: userId, teamId });
  const teammate = await lead("teammate@example.com", agent);
  const outside = await lead("outside@example.com", other);
  const pool = await lead("pool@example.com", null);
  const account = await db.seedAccount();
  const outsideAccount = await db.seedAccount();
  await db.rows("UPDATE accounts SET owner_id=$1, team_id=$2 WHERE id=$3", [
    userId,
    teamId,
    account,
  ]);
  await db.rows("UPDATE accounts SET owner_id=$1, team_id=$2 WHERE id=$3", [
    otherId,
    otherTeamId,
    outsideAccount,
  ]);
  return { actor, agent, other, own, teammate, outside, pool, account, outsideAccount };
}

async function auditCount(db: TestDatabase) {
  return db.rows(
    "SELECT (SELECT count(*)::int FROM activities WHERE kind='assignment') AS activities, (SELECT count(*)::int FROM audit_log) AS audit, (SELECT count(*)::int FROM distributions) AS distributions",
  );
}

describe("assignment under contention", () => {
  test("two managers race one pool lead, with one typed conflict and one complete history", async ({
    db,
  }) => {
    const w = await world(db);
    const second: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
    await db.gate.close();
    const pending = Promise.allSettled([
      db.store.assignPool(w.actor, [w.pool], w.agent),
      db.store.assignPool(second, [w.pool], w.other),
    ]);
    try {
      await db.gate.waitForWaiters(2);
    } finally {
      await db.gate.open();
    }
    const results = await pending;
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({
      code: "conflict",
    });
    const winner = results.find((r) => r.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("No assignment won");
    expect(
      await db.rows("SELECT status, owner_id AS owner, team_id AS team FROM leads WHERE id=$1", [
        w.pool,
      ]),
    ).toEqual([
      {
        status: "assigned",
        owner: winner.value.items[0]?.to.ownerId,
        team: winner.value.items[0]?.to.teamId,
      },
    ]);
    expect(await auditCount(db)).toEqual([{ activities: 1, audit: 1, distributions: 0 }]);
  });

  test("stale previews refuse owner changes, including a return to the original pool state", async ({
    db,
  }) => {
    const w = await world(db);
    const preview = await db.store.previewDistribution(w.actor, {
      leadIds: [w.pool],
      agents: [w.agent],
      excludePreviousOwner: false,
    });
    await db.store.assignPool(w.actor, [w.pool], w.agent);
    const input = { previewId: preview.id, fingerprint: preview.fingerprint, key: "stale" };
    await expect(db.store.submitDistribution(w.actor, input)).rejects.toMatchObject({
      code: "stalePreview",
    });
    await db.rows("UPDATE leads SET status='new',owner_id=NULL,team_id=NULL WHERE id=$1", [w.pool]);
    await expect(db.store.submitDistribution(w.actor, input)).rejects.toMatchObject({
      code: "stalePreview",
    });
    expect(await auditCount(db)).toEqual([{ activities: 1, audit: 1, distributions: 0 }]);
  });

  test("a status-only change invalidates a preview", async ({ db }) => {
    const w = await world(db);
    const preview = await db.store.previewDistribution(w.actor, {
      leadIds: [w.pool],
      agents: [w.agent],
      excludePreviousOwner: false,
    });
    await db.rows("UPDATE leads SET status='dead',dead_reason='duplicate' WHERE id=$1", [w.pool]);
    await expect(
      db.store.submitDistribution(w.actor, {
        previewId: preview.id,
        fingerprint: preview.fingerprint,
        key: "status",
      }),
    ).rejects.toMatchObject({ code: "stalePreview" });
    expect(await auditCount(db)).toEqual([{ activities: 0, audit: 0, distributions: 0 }]);
  });

  test("concurrent submits and later replays return the first result without new rows", async ({
    db,
  }) => {
    const w = await world(db);
    const preview = await db.store.previewDistribution(w.actor, {
      leadIds: [w.pool],
      agents: [w.agent],
      excludePreviousOwner: false,
    });
    const input = { previewId: preview.id, fingerprint: preview.fingerprint, key: "same-request" };
    await db.gate.close();
    const pending = Promise.all([
      db.store.submitDistribution(w.actor, input),
      db.store.submitDistribution(w.actor, input),
    ]);
    try {
      await db.gate.waitForWaiters(2);
    } finally {
      await db.gate.open();
    }
    const [first, second] = await pending;
    expect(first).toEqual(second);
    expect(await db.store.submitDistribution(w.actor, input)).toEqual(first);
    await expect(
      db.store.submitDistribution(w.actor, {
        ...input,
        previewId: crypto.randomUUID(),
        fingerprint: "changed",
      }),
    ).rejects.toMatchObject({
      code: "idempotencyConflict",
      message: "The key was already used for a different request.",
    });
    expect(await auditCount(db)).toEqual([{ activities: 1, audit: 1, distributions: 1 }]);
  });

  test("previous-owner exclusion and round-robin are visible in the submitted owners", async ({
    db,
  }) => {
    const w = await world(db);
    const more: LeadId[] = [w.pool];
    for (const email of ["second@example.com", "third@example.com", "fourth@example.com"])
      more.push(
        await db.seedLead({
          email,
          lifecycle: { state: { status: "new" }, firstAssignedAt: null, previousOwnerId: null },
        }),
      );
    const preview = await db.store.previewDistribution(w.actor, {
      leadIds: more,
      agents: [w.agent, w.other],
      excludePreviousOwner: false,
    });
    const result = await db.store.submitDistribution(w.actor, {
      previewId: preview.id,
      fingerprint: preview.fingerprint,
      key: "round-robin",
    });
    expect(result.items.filter((item) => item.to.ownerId === w.agent.ownerId)).toHaveLength(2);
    expect(result.items.filter((item) => item.to.ownerId === w.other.ownerId)).toHaveLength(2);
    const excluded = await db.seedLead({
      email: "excluded@example.com",
      lifecycle: {
        state: { status: "new" },
        firstAssignedAt: new Date(),
        previousOwnerId: w.agent.ownerId,
      },
    });
    const planned = await db.store.previewDistribution(w.actor, {
      leadIds: [excluded],
      agents: [w.agent, w.other],
      excludePreviousOwner: true,
    });
    expect(planned.items[0]?.to).toEqual(w.other);
    await expect(
      db.store.previewDistribution(w.actor, {
        leadIds: [excluded],
        agents: [w.agent],
        excludePreviousOwner: true,
      }),
    ).rejects.toMatchObject({ code: "noEligibleAgent" });
  });

  test("reassignment preserves working status and stage and the audit is append-only", async ({
    db,
  }) => {
    const w = await world(db);
    await db.rows(
      "UPDATE leads SET status='working',stage='noAnswer',no_answer_count=2 WHERE id=$1",
      [w.teammate],
    );
    await db.store.reassignLead(w.actor, w.teammate, w.other);
    expect((await db.store.getLead(w.actor, w.teammate)).lifecycle.state).toEqual({
      status: "working",
      assignee: w.other,
      stage: { kind: "noAnswer", count: 2 },
    });
    expect((await db.store.getLead(w.actor, w.teammate)).lifecycle.previousOwnerId).toBe(
      w.agent.ownerId,
    );
    await expect(db.rows("UPDATE audit_log SET action='changed'")).rejects.toThrow("append-only");
    await expect(db.rows("DELETE FROM audit_log")).rejects.toThrow("append-only");
  });

  test("a failed audit write rolls back both ownership and activity", async ({ db }) => {
    const w = await world(db);
    await db.rows(
      "CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_audit()",
    );
    await expect(db.store.assignPool(w.actor, [w.pool], w.agent)).rejects.toThrow();
    expect((await db.store.getLead(w.actor, w.pool)).lifecycle.state.status).toBe("new");
    expect(await auditCount(db)).toEqual([{ activities: 0, audit: 0, distributions: 0 }]);
  });
});

describe("record scoping", () => {
  test.for(ROLES)(
    "enforces %s on reads, edits and every assignment operation",
    async (role, { db }) => {
      const w = await world(db, role);
      const management = ["owner", "admin", "manager"].includes(role);
      const assigns = management || role === "teamLead";
      const reads = management
        ? [w.own, w.teammate, w.outside, w.pool]
        : role === "teamLead"
          ? [w.own, w.teammate, w.pool]
          : role === "agent"
            ? [w.own]
            : [];
      expect((await db.store.listLeads(w.actor, { limit: 100 })).map((l) => l.id).sort()).toEqual(
        [...reads].sort(),
      );
      for (const id of [w.own, w.teammate, w.outside, w.pool]) {
        const query = db.store.getLead(w.actor, id);
        if (reads.includes(id)) expect((await query).id).toBe(id);
        else await expect(query).rejects.toMatchObject({ code: "accessDenied" });
      }
      const accounts =
        management || role === "accountant" ? [w.account, w.outsideAccount] : [w.account];
      expect(
        (await db.store.listAccounts(w.actor, { limit: 100 })).map((a) => a.id).sort(),
      ).toEqual([...accounts].sort());
      for (const id of [w.account, w.outsideAccount]) {
        const query = db.store.getAccount(w.actor, id);
        if (accounts.includes(id)) expect((await query).id).toBe(id);
        else await expect(query).rejects.toMatchObject({ code: "accessDenied" });
      }
      for (const id of [w.own, w.teammate, w.outside, w.pool]) {
        const edit = db.store.editLead(w.actor, id, { name: "Edited", phone: null });
        if (management || (role !== "accountant" && id === w.own))
          expect((await edit).name).toBe("Edited");
        else await expect(edit).rejects.toMatchObject({ code: "accessDenied" });
      }
      const previewInput = { leadIds: [w.pool], agents: [w.agent], excludePreviousOwner: false };
      if (assigns) {
        const preview = await db.store.previewDistribution(w.actor, previewInput);
        expect(
          (
            await db.store.submitDistribution(w.actor, {
              previewId: preview.id,
              fingerprint: preview.fingerprint,
              key: "allowed",
            })
          ).items,
        ).toHaveLength(1);
        await db.store.reassignLead(w.actor, w.teammate, w.agent);
        const another = await db.seedLead({
          email: "manual@example.com",
          lifecycle: { state: { status: "new" }, firstAssignedAt: null, previousOwnerId: null },
        });
        await db.store.assignPool(w.actor, [another], w.agent);
        if (role === "teamLead") {
          await expect(db.store.reassignLead(w.actor, w.outside, w.agent)).rejects.toMatchObject({
            code: "accessDenied",
          });
          const fresh = await db.seedLead({
            email: "foreign-agent@example.com",
            lifecycle: { state: { status: "new" }, firstAssignedAt: null, previousOwnerId: null },
          });
          await expect(db.store.assignPool(w.actor, [fresh], w.other)).rejects.toMatchObject({
            code: "accessDenied",
          });
        }
      } else {
        await expect(db.store.previewDistribution(w.actor, previewInput)).rejects.toMatchObject({
          code: "accessDenied",
        });
        await expect(
          db.store.submitDistribution(w.actor, {
            previewId: crypto.randomUUID(),
            fingerprint: "fake",
            key: "denied",
          }),
        ).rejects.toMatchObject({ code: "accessDenied" });
        await expect(db.store.assignPool(w.actor, [w.pool], w.agent)).rejects.toMatchObject({
          code: "accessDenied",
        });
        await expect(db.store.assignPool(w.actor, [w.outside], w.agent)).rejects.toMatchObject({
          code: "accessDenied",
        });
        await expect(db.store.reassignLead(w.actor, w.own, w.agent)).rejects.toMatchObject({
          code: "accessDenied",
        });
      }
    },
  );

  test("writes re-read role and membership instead of trusting the actor or preview", async ({
    db,
  }) => {
    const w = await world(db, "teamLead");
    const preview = await db.store.previewDistribution(w.actor, {
      leadIds: [w.pool],
      agents: [w.agent],
      excludePreviousOwner: false,
    });
    await db.rows("UPDATE users SET role='agent' WHERE id=$1", [w.actor.userId]);
    await expect(
      db.store.submitDistribution(w.actor, {
        previewId: preview.id,
        fingerprint: preview.fingerprint,
        key: "revoked",
      }),
    ).rejects.toMatchObject({ code: "accessDenied" });
    await expect(db.store.assignPool(w.actor, [w.pool], w.agent)).rejects.toMatchObject({
      code: "accessDenied",
    });
    await db.rows("UPDATE users SET role='teamLead' WHERE id=$1", [w.actor.userId]);
    await db.rows("DELETE FROM memberships WHERE user_id=$1", [w.actor.userId]);
    await expect(db.store.assignPool(w.actor, [w.pool], w.agent)).rejects.toMatchObject({
      code: "accessDenied",
    });
  });
});

test("a replay returns only the first result after scope and role change", async ({ db }) => {
  const w = await world(db, "teamLead");
  const manager: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
  const preview = await db.store.previewDistribution(w.actor, {
    leadIds: [w.pool],
    agents: [w.agent],
    excludePreviousOwner: false,
  });
  const input = { previewId: preview.id, fingerprint: preview.fingerprint, key: "moved" };
  const first = await db.store.submitDistribution(w.actor, input);
  await db.store.reassignLead(manager, w.pool, w.other);
  await db.rows("UPDATE users SET role='accountant' WHERE id=$1", [w.actor.userId]);
  expect(await db.store.submitDistribution(w.actor, input)).toEqual(first);
  expect(await auditCount(db)).toEqual([{ activities: 2, audit: 2, distributions: 1 }]);
  await expect(db.store.submitDistribution(manager, input)).rejects.toMatchObject({
    code: "stalePreview",
  });
  await db.rows("UPDATE users SET role='agent' WHERE id=$1", [w.actor.userId]);
  expect(await db.store.submitDistribution(w.actor, input)).toEqual(first);
});

test("foreign target membership and non-membership have the same refusal", async ({ db }) => {
  const w = await world(db, "teamLead");
  for (const to of [w.other, { ownerId: w.agent.ownerId, teamId: w.other.teamId }]) {
    await expect(db.store.assignPool(w.actor, [w.pool], to)).rejects.toMatchObject({
      code: "accessDenied",
    });
  }
});

test("lead lists reload the current role and membership", async ({ db }) => {
  const w = await world(db);
  await db.rows("UPDATE users SET role='agent' WHERE id=$1", [w.actor.userId]);
  expect((await db.store.listLeads(w.actor, { limit: 100 })).map((l) => l.id)).toEqual([w.own]);
  await db.rows("UPDATE users SET role='teamLead' WHERE id=$1", [w.actor.userId]);
  await db.rows("DELETE FROM memberships WHERE user_id=$1", [w.actor.userId]);
  expect((await db.store.listLeads(w.actor, { limit: 100 })).map((l) => l.id)).toEqual([w.own]);
});

test("reassigning the current owner reports no change and writes no history", async ({ db }) => {
  const w = await world(db);
  const before = await db.rows("SELECT version FROM leads WHERE id=$1", [w.teammate]);
  expect(await db.store.reassignLead(w.actor, w.teammate, w.agent)).toEqual({
    items: [],
    changed: false,
  });
  expect(await db.rows("SELECT version FROM leads WHERE id=$1", [w.teammate])).toEqual(before);
  expect(await auditCount(db)).toEqual([{ activities: 0, audit: 0, distributions: 0 }]);
});

test("intake reopening records the removed owner under its system actor", async ({ db }) => {
  const w = await world(db);
  await db.rows("UPDATE leads SET status='lost',lost_reason='badTiming' WHERE id=$1", [w.teammate]);
  const result = await db.store.intake(submissionExample({ email: "teammate@example.com" }));
  expect(result.outcome.kind).toBe("leadReopened");
  expect(await db.rows("SELECT actor_id,system_actor,action,subject_id FROM audit_log")).toEqual([
    { actor_id: null, system_actor: "intake", action: "leadReopened", subject_id: w.teammate },
  ]);
  expect((await db.store.getLead(w.actor, w.teammate)).lifecycle.state.status).toBe("new");
});
