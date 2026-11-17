import type { Actor, Assignment, LeadId, Role } from "@relay/domain";
import { submissionExample } from "@relay/domain/testing";
import pg from "pg";
import { describe, expect } from "vitest";
import { test, type TestDatabase } from "../src/testing/index.ts";

async function world(db: TestDatabase, role: Role = "manager") {
  const teamId = await db.seedTeam("sales");
  const otherTeamId = await db.seedTeam("sales");
  const userId = await db.seedUser(role);
  const agentId = await db.seedUser("agent");
  const agent2Id = await db.seedUser("agent");
  const otherId = await db.seedUser("agent");
  for (const [user, team, lead] of [
    [userId, teamId, true],
    [agentId, teamId, false],
    [agent2Id, teamId, false],
    [otherId, otherTeamId, false],
  ] as const) {
    await db.ownerRows("INSERT INTO memberships(user_id, team_id, is_lead) VALUES ($1,$2,$3)", [
      user,
      team,
      lead,
    ]);
  }
  const actor: Actor = { userId, role, team: { id: teamId, kind: "sales", isLead: true } };
  const agent: Assignment = { ownerId: agentId, teamId };
  const agent2: Assignment = { ownerId: agent2Id, teamId };
  const other: Assignment = { ownerId: otherId, teamId: otherTeamId };
  const pool = (email: string) =>
    db.seedLead({
      email,
      lifecycle: { state: { status: "new" }, firstAssignedAt: null, previousOwnerId: null },
    });
  return { actor, agent, agent2, other, teamId, otherTeamId, pool };
}

const counts = (db: TestDatabase) =>
  db.ownerRows(
    "SELECT (SELECT count(*)::int FROM activities WHERE kind='assignment') AS activities, (SELECT count(*)::int FROM audit_log) AS audit, (SELECT count(*)::int FROM idempotency_records WHERE operation='distribution.submit') AS distributions",
  );

async function race(db: TestDatabase, n: number, calls: () => readonly Promise<unknown>[]) {
  await db.gate.close();
  const pending = Promise.allSettled(calls());
  try {
    await db.gate.waitForWaiters(n);
  } finally {
    await db.gate.open();
  }
  return pending;
}

describe("distribution idempotency", () => {
  test("a key reused with a different preview is refused", async ({ db }) => {
    const w = await world(db);
    const a = await w.pool("a@example.com");
    const b = await w.pool("b@example.com");
    const p1 = await db.store.previewDistribution(w.actor, {
      leadIds: [a],
      agents: [w.agent],
      excludePreviousOwner: false,
    });
    const p2 = await db.store.previewDistribution(w.actor, {
      leadIds: [b],
      agents: [w.agent2],
      excludePreviousOwner: false,
    });
    const first = await db.store.submitDistribution(
      w.actor,
      {
        previewId: p1.id,
        fingerprint: p1.fingerprint,
        key: "k",
      },
      "00000000-0000-4000-8000-000000000001",
    );
    await expect(
      db.store.submitDistribution(
        w.actor,
        {
          previewId: p2.id,
          fingerprint: p2.fingerprint,
          key: "k",
        },
        "00000000-0000-4000-8000-000000000001",
      ),
    ).rejects.toMatchObject({ code: "idempotencyConflict" });
    expect(first.items).toHaveLength(1);
    expect(await db.rows("SELECT status FROM leads WHERE id=$1", [b])).toEqual([{ status: "new" }]);
  });

  test("a team lead's replay after a manager moved the lead returns the first result", async ({
    db,
  }) => {
    const w = await world(db, "teamLead");
    const manager: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
    const a = await w.pool("a@example.com");
    const p = await db.store.previewDistribution(w.actor, {
      leadIds: [a],
      agents: [w.agent],
      excludePreviousOwner: false,
    });
    const input = { previewId: p.id, fingerprint: p.fingerprint, key: "k" };
    const first = await db.store.submitDistribution(
      w.actor,
      input,
      "00000000-0000-4000-8000-000000000001",
    );
    await db.store.reassignLead(manager, a, w.other, "00000000-0000-4000-8000-000000000001");
    const replay = db.store.submitDistribution(
      w.actor,
      input,
      "00000000-0000-4000-8000-000000000001",
    );
    expect(await replay).toEqual(first);
    expect(first.items).toHaveLength(1);
  });

  test("replay of a key whose lead moved on still returns the original owners", async ({ db }) => {
    const w = await world(db);
    const a = await w.pool("a@example.com");
    const p = await db.store.previewDistribution(w.actor, {
      leadIds: [a],
      agents: [w.agent],
      excludePreviousOwner: false,
    });
    const input = { previewId: p.id, fingerprint: p.fingerprint, key: "k" };
    const first = await db.store.submitDistribution(
      w.actor,
      input,
      "00000000-0000-4000-8000-000000000001",
    );
    await db.store.reassignLead(w.actor, a, w.agent2, "00000000-0000-4000-8000-000000000001");
    expect(
      await db.store.submitDistribution(w.actor, input, "00000000-0000-4000-8000-000000000001"),
    ).toEqual(first);
    expect(await counts(db)).toEqual([{ activities: 2, audit: 2, distributions: 1 }]);
  });
});

describe("distribution races", () => {
  test("two previews over overlapping leads submitted at once: one wins, one is stale", async ({
    db,
  }) => {
    const w = await world(db);
    const a = await w.pool("a@example.com");
    const b = await w.pool("b@example.com");
    const c = await w.pool("c@example.com");
    const p1 = await db.store.previewDistribution(w.actor, {
      leadIds: [a, b],
      agents: [w.agent],
      excludePreviousOwner: false,
    });
    const p2 = await db.store.previewDistribution(w.actor, {
      leadIds: [b, c],
      agents: [w.agent2],
      excludePreviousOwner: false,
    });
    const results = await race(db, 2, () => [
      db.store.submitDistribution(
        w.actor,
        {
          previewId: p1.id,
          fingerprint: p1.fingerprint,
          key: "1",
        },
        "00000000-0000-4000-8000-000000000001",
      ),
      db.store.submitDistribution(
        w.actor,
        {
          previewId: p2.id,
          fingerprint: p2.fingerprint,
          key: "2",
        },
        "00000000-0000-4000-8000-000000000001",
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({
      code: "stalePreview",
    });
    expect(await counts(db)).toEqual([{ activities: 2, audit: 2, distributions: 1 }]);
    const statuses = await db.rows("SELECT status FROM leads ORDER BY email");
    expect(statuses.filter((s) => s.status === "assigned")).toHaveLength(2);
  });

  test("two submits of one preview under different keys: exactly one applies", async ({ db }) => {
    const w = await world(db);
    const a = await w.pool("a@example.com");
    const p = await db.store.previewDistribution(w.actor, {
      leadIds: [a],
      agents: [w.agent],
      excludePreviousOwner: false,
    });
    const results = await race(db, 2, () => [
      db.store.submitDistribution(
        w.actor,
        {
          previewId: p.id,
          fingerprint: p.fingerprint,
          key: "x",
        },
        "00000000-0000-4000-8000-000000000001",
      ),
      db.store.submitDistribution(
        w.actor,
        {
          previewId: p.id,
          fingerprint: p.fingerprint,
          key: "y",
        },
        "00000000-0000-4000-8000-000000000001",
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await counts(db)).toEqual([{ activities: 1, audit: 1, distributions: 1 }]);
  });

  test("a submit racing a manual assignPool of the same lead", async ({ db }) => {
    const w = await world(db);
    const a = await w.pool("a@example.com");
    const p = await db.store.previewDistribution(w.actor, {
      leadIds: [a],
      agents: [w.agent],
      excludePreviousOwner: false,
    });
    const results = await race(db, 2, () => [
      db.store.submitDistribution(
        w.actor,
        {
          previewId: p.id,
          fingerprint: p.fingerprint,
          key: "x",
        },
        "00000000-0000-4000-8000-000000000001",
      ),
      db.store.assignPool(w.actor, [a], w.agent2, "00000000-0000-4000-8000-000000000001"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rows = await counts(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ activities: 1, audit: 1 });
    expect(rows[0]?.distributions).toBeTypeOf("number");
  });

  test("a submit racing intake on a pooled lead preserves its assignment", async ({ db }) => {
    const w = await world(db);
    const a = await w.pool("a@example.com");
    const p = await db.store.previewDistribution(w.actor, {
      leadIds: [a],
      agents: [w.agent],
      excludePreviousOwner: false,
    });
    const results = await race(db, 2, () => [
      db.store.submitDistribution(
        w.actor,
        {
          previewId: p.id,
          fingerprint: p.fingerprint,
          key: "x",
        },
        "00000000-0000-4000-8000-000000000001",
      ),
      db.store.intake(submissionExample({ email: "a@example.com", externalId: "race-1" })),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await db.rows("SELECT status, owner_id FROM leads WHERE id=$1", [a])).toEqual([
      { status: "assigned", owner_id: w.agent.ownerId },
    ]);
  });

  test("submit racing a role change of the target agent (serializable writer)", async ({ db }) => {
    const w = await world(db);
    const a = await w.pool("a@example.com");
    const p = await db.store.previewDistribution(w.actor, {
      leadIds: [a],
      agents: [w.agent],
      excludePreviousOwner: false,
    });
    const client = new pg.Client({ connectionString: db.connectionString });
    await client.connect();
    try {
      await db.gate.close();
      const submit = db.store.submitDistribution(
        w.actor,
        {
          previewId: p.id,
          fingerprint: p.fingerprint,
          key: "x",
        },
        "00000000-0000-4000-8000-000000000001",
      );
      await db.gate.waitForWaiters(1);
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("UPDATE users SET role='manager' WHERE id=$1", [w.agent.ownerId]);
      await client.query("COMMIT");
      await db.gate.open();
      const result = await submit.then(
        (v) => ({ ok: true, v }),
        (e: unknown) => ({ ok: false, e }),
      );
      // Serial order "submit, then role change" is valid; record what happened.
      expect(result.ok).toBe(true);
    } finally {
      await client.end();
    }
  });
});

describe("scoped records", () => {
  test("a team lead cannot edit a lead their read scope denies", async ({ db }) => {
    const w = await world(db, "teamLead");
    const mineElsewhere: LeadId = await db.seedLead({
      email: "mine-elsewhere@example.com",
      lifecycle: {
        state: { status: "assigned", assignee: { ownerId: w.actor.userId, teamId: w.otherTeamId } },
        firstAssignedAt: new Date(),
        previousOwnerId: null,
      },
    });
    await expect(db.store.getLead(w.actor, mineElsewhere)).rejects.toMatchObject({
      code: "accessDenied",
    });
    const listed = await db.store.listLeads(w.actor, { limit: 100 });
    expect(listed.map((l) => l.id)).not.toContain(mineElsewhere);
    await expect(
      db.store.editLead(w.actor, mineElsewhere, { name: "X", phone: null }, crypto.randomUUID()),
    ).rejects.toMatchObject({ code: "accessDenied" });
  });

  test("foreign team membership and non-membership return the same refusal", async ({ db }) => {
    const w = await world(db, "teamLead");
    const a = await w.pool("a@example.com");
    await expect(
      db.store.assignPool(w.actor, [a], w.other, "00000000-0000-4000-8000-000000000001"),
    ).rejects.toMatchObject({
      code: "accessDenied",
    });
    await expect(
      db.store.assignPool(
        w.actor,
        [a],
        { ownerId: w.agent.ownerId, teamId: w.otherTeamId },
        "00000000-0000-4000-8000-000000000001",
      ),
    ).rejects.toMatchObject({ code: "accessDenied" });
  });

  test("a team lead with a sole membership uses it without an explicit choice", async ({ db }) => {
    const w = await world(db, "teamLead");
    const a = await w.pool("a@example.com");
    const noTeam: Actor = { ...w.actor, team: null };
    expect((await db.store.listLeads(noTeam, { limit: 100 })).map((lead) => lead.id)).toEqual([a]);
    expect(
      (await db.store.assignPool(noTeam, [a], w.agent, "00000000-0000-4000-8000-000000000001"))
        .items,
    ).toEqual([{ leadId: a, to: w.agent }]);
  });

  test("listLeads reloads the current role", async ({ db }) => {
    const w = await world(db, "manager");
    await w.pool("a@example.com");
    await db.rows("UPDATE users SET role='agent' WHERE id=$1", [w.actor.userId]);
    expect(await db.store.listLeads(w.actor, { limit: 100 })).toHaveLength(0);
    expect(await db.store.listAccounts(w.actor, { limit: 100 })).toEqual({
      items: [],
      total: 0,
      order: "name",
    });
  });

  test("a team lead cannot submit a preview targeting a different current team", async ({ db }) => {
    const w = await world(db, "teamLead");
    await db.ownerRows("INSERT INTO memberships(user_id, team_id, is_lead) VALUES ($1,$2,true)", [
      w.actor.userId,
      w.otherTeamId,
    ]);
    const a = await w.pool("a@example.com");
    const p = await db.store.previewDistribution(w.actor, {
      leadIds: [a],
      agents: [w.agent],
      excludePreviousOwner: false,
    });
    const switched: Actor = {
      ...w.actor,
      team: { id: w.otherTeamId, kind: "sales", isLead: true },
    };
    await expect(
      db.store.submitDistribution(
        switched,
        {
          previewId: p.id,
          fingerprint: p.fingerprint,
          key: "k",
        },
        "00000000-0000-4000-8000-000000000001",
      ),
    ).rejects.toMatchObject({ code: "accessDenied" });
  });

  test("assignment to a team lead or to a non-member is refused", async ({ db }) => {
    const w = await world(db, "teamLead");
    const a = await w.pool("a@example.com");
    await expect(
      db.store.assignPool(
        w.actor,
        [a],
        { ownerId: w.actor.userId, teamId: w.teamId },
        "00000000-0000-4000-8000-000000000001",
      ),
    ).rejects.toMatchObject({ code: "invalidAgent" });
    await expect(
      db.store.assignPool(
        w.actor,
        [a],
        { ownerId: await db.seedUser("agent"), teamId: w.teamId },
        "00000000-0000-4000-8000-000000000001",
      ),
    ).rejects.toMatchObject({ code: "accessDenied" });
  });
});

describe("request limits", () => {
  test.for([100, 10])("a burst on a shared bucket with a limit of %s", async (limit, { db }) => {
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, () => db.store.takeRequestLimit("auth:global", limit, 60)),
    );
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(0);
    expect(results.filter((result) => result.status === "fulfilled" && result.value)).toHaveLength(
      Math.min(40, limit),
    );
    expect(await db.rows("SELECT count FROM auth_request_limits WHERE key='auth:global'")).toEqual([
      { count: Math.min(40, limit) },
    ]);
    await db.rows("UPDATE auth_request_limits SET started_at=now()-interval '61 seconds'");
    expect(await db.store.takeRequestLimit("auth:global", limit, 60)).toBe(true);
    expect(await db.rows("SELECT count FROM auth_request_limits WHERE key='auth:global'")).toEqual([
      { count: 1 },
    ]);
  });
});

test("a foreign agent named with the caller's team is outside scope", async ({ db }) => {
  const w = await world(db, "teamLead");
  const id = await w.pool("scope@example.com");
  await expect(
    db.store.assignPool(
      w.actor,
      [id],
      { ownerId: w.other.ownerId, teamId: w.teamId },
      "00000000-0000-4000-8000-000000000001",
    ),
  ).rejects.toMatchObject({ code: "accessDenied" });
});

test("request writes remove only a bounded number of expired windows", async ({ db }) => {
  await db.rows(
    "INSERT INTO auth_request_limits(key,count,started_at) SELECT 'expired-' || n,1,now()-interval '2 minutes' FROM generate_series(1,105) AS n",
  );
  expect(await db.store.takeRequestLimit("live", 1, 60)).toBe(true);
  expect(
    await db.rows("SELECT count(*)::int AS n FROM auth_request_limits WHERE key LIKE 'expired-%'"),
  ).toEqual([{ n: 5 }]);
  expect(await db.store.takeRequestLimit("live", 1, 60)).toBe(false);
  expect(await db.rows("SELECT key,count FROM auth_request_limits")).toEqual([
    { key: "live", count: 1 },
  ]);
});

test("cleanup respects the duration stored on each window", async ({ db }) => {
  expect(await db.store.takeRequestLimit("long", 1, 3600)).toBe(true);
  await db.rows(
    "UPDATE auth_request_limits SET started_at=now()-interval '61 seconds' WHERE key='long'",
  );
  expect(await db.store.takeRequestLimit("short", 1, 60)).toBe(true);
  expect(await db.store.takeRequestLimit("long", 1, 3600)).toBe(false);
  expect(await db.rows("SELECT key FROM auth_request_limits ORDER BY key")).toEqual([
    { key: "long" },
    { key: "short" },
  ]);
});

test("every submitted lead keeps its previewed owner and team", async ({ db }) => {
  const w = await world(db);
  const leadIds = await Promise.all(
    Array.from({ length: 7 }, (_, index) => w.pool(`plan-${String(index)}@example.com`)),
  );
  const preview = await db.store.previewDistribution(w.actor, {
    leadIds,
    agents: [w.agent, w.agent2, w.other],
    excludePreviousOwner: false,
  });
  const result = await db.store.submitDistribution(
    w.actor,
    {
      previewId: preview.id,
      fingerprint: preview.fingerprint,
      key: "exact-plan",
    },
    "00000000-0000-4000-8000-000000000001",
  );
  expect(result.items).toEqual(preview.items);
  for (const item of preview.items) {
    expect(await db.rows("SELECT owner_id, team_id FROM leads WHERE id=$1", [item.leadId])).toEqual(
      [{ owner_id: item.to.ownerId, team_id: item.to.teamId }],
    );
  }
});

test("three submitted two-lead previews reach all three agents", async ({ db }) => {
  const w = await world(db);
  const agents = [w.agent, w.agent2, w.other].sort((a, b) => a.ownerId.localeCompare(b.ownerId));
  const chosen: string[][] = [];
  for (let batch = 0; batch < 3; batch += 1) {
    const leadIds = await Promise.all([
      w.pool(`batch-${String(batch)}-a@example.com`),
      w.pool(`batch-${String(batch)}-b@example.com`),
    ]);
    const preview = await db.store.previewDistribution(w.actor, {
      leadIds,
      agents,
      excludePreviousOwner: false,
    });
    chosen.push(preview.items.map((item) => item.to.ownerId));
    expect(await db.rows("SELECT status FROM leads WHERE id = ANY($1::uuid[])", [leadIds])).toEqual(
      [{ status: "new" }, { status: "new" }],
    );
    const result = await db.store.submitDistribution(
      w.actor,
      { previewId: preview.id, fingerprint: preview.fingerprint, key: `batch-${String(batch)}` },
      "00000000-0000-4000-8000-000000000001",
    );
    expect(result.items).toEqual(preview.items);
  }
  expect(chosen).toEqual([
    [agents[0]?.ownerId, agents[1]?.ownerId],
    [agents[2]?.ownerId, agents[0]?.ownerId],
    [agents[1]?.ownerId, agents[2]?.ownerId],
  ]);
});

test("an empty queue precedes a full queue and later queue changes preserve the preview", async ({
  db,
}) => {
  const w = await world(db);
  await db.store.assignPool(
    w.actor,
    [await w.pool("existing@example.com")],
    w.agent,
    "00000000-0000-4000-8000-000000000001",
  );
  const preview = await db.store.previewDistribution(w.actor, {
    leadIds: [await w.pool("next@example.com")],
    agents: [w.agent, w.agent2],
    excludePreviousOwner: false,
  });
  expect(preview.items[0]?.to).toEqual(w.agent2);
  await db.store.assignPool(
    w.actor,
    [await w.pool("intervening-a@example.com"), await w.pool("intervening-b@example.com")],
    w.agent2,
    "00000000-0000-4000-8000-000000000001",
  );
  const result = await db.store.submitDistribution(
    w.actor,
    { previewId: preview.id, fingerprint: preview.fingerprint, key: "frozen-plan" },
    "00000000-0000-4000-8000-000000000001",
  );
  expect(result.items).toEqual(preview.items);
});
