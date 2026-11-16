import { randomUUID } from "node:crypto";
import { ROLES, type Actor, type LeadId, type LeadWork, type Role } from "@relay/domain";
import { submissionExample } from "@relay/domain/testing";
import { expect } from "vitest";
import { test, type TestDatabase } from "../src/testing/index.ts";

const AT = new Date("2026-11-16T12:00:00Z");
const FUTURE = new Date("2099-11-16T12:00:00Z");
const noAnswer: LeadWork = {
  kind: "attempt",
  attempt: { channel: "call", outcome: "noAnswer", note: "Rang out" },
};
const spoke: LeadWork = {
  kind: "attempt",
  attempt: { channel: "whatsApp", outcome: "spokeToThem", note: "Discussed the course" },
};
const won: LeadWork = { kind: "close", closing: { kind: "won" } };
const lost: LeadWork = {
  kind: "close",
  closing: { kind: "lost", note: "Chose a closer school" },
};

async function world(db: TestDatabase) {
  const team = await db.seedTeam("sales");
  const otherTeam = await db.seedTeam("sales");
  const makeActor = async (role: Role, teamId = team): Promise<Actor> => {
    const userId = await db.seedUser(role);
    await db.ownerRows("INSERT INTO memberships(user_id,team_id,is_lead) VALUES ($1,$2,$3)", [
      userId,
      teamId,
      role === "teamLead",
    ]);
    return { userId, role, team: { id: teamId, kind: "sales", isLead: role === "teamLead" } };
  };
  const agent = await makeActor("agent");
  const other = await makeActor("agent", otherTeam);
  const manager = await makeActor("manager");
  const makeLead = async (actor = agent, email = `${randomUUID()}@example.com`) => {
    if (actor.role !== "agent")
      return db.seedLead({
        email,
        lifecycle: {
          state: {
            status: "assigned",
            assignee: { ownerId: actor.userId, teamId: actor.team?.id ?? team },
          },
          firstAssignedAt: AT,
          previousOwnerId: null,
        },
      });
    const result = await db.store.intake(
      submissionExample({ email, externalId: email, campaign: "Evening course" }),
    );
    if (!("leadId" in result.outcome)) throw new Error("Expected a lead");
    const id = result.outcome.leadId;
    await db.store.assignPool(
      manager,
      [id],
      { ownerId: actor.userId, teamId: actor.team?.id ?? team },
      randomUUID(),
    );
    return id;
  };
  const work = (actor: Actor, id: LeadId, command: LeadWork, key: string = randomUUID()) =>
    db.store.workLead(actor, { id, key, work: command }, randomUUID());
  return { agent, other, manager, makeActor, makeLead, work, team, otherTeam };
}

test("only spoke to them records contact and no-answer history survives callbacks", async ({
  db,
}) => {
  const w = await world(db);
  const id = await w.makeLead();
  await w.work(w.agent, id, noAnswer);
  let detail = await db.store.getLead(w.agent, id);
  expect(detail.contactedAt).toBeNull();
  expect(detail.lifecycle.state).toMatchObject({
    status: "working",
    stage: { kind: "noAnswer", count: 1 },
  });
  expect((await db.store.campaignFunnel(w.manager)).rows[0]).toMatchObject({
    received: 1,
    contacted: 0,
    won: 0,
  });
  await w.work(w.agent, id, { kind: "callback", change: { kind: "set", at: FUTURE } });
  await w.work(w.agent, id, {
    ...noAnswer,
    attempt: { ...noAnswer.attempt, callback: { kind: "set", at: FUTURE } },
  });
  detail = await db.store.getLead(w.agent, id);
  expect(detail.noAnswerCount).toBe(2);
  expect(detail.contactedAt).toBeNull();
  expect(detail.lifecycle.state).toMatchObject({ stage: { kind: "callBack", at: FUTURE } });
  await w.work(w.agent, id, spoke);
  detail = await db.store.getLead(w.agent, id);
  expect(detail.contactedAt).toBeInstanceOf(Date);
  expect(detail.noAnswerCount).toBe(2);
  expect((await db.store.campaignFunnel(w.manager)).rows[0]).toMatchObject({ contacted: 1 });
});

test("a work replay has one activity and audit with the acting user and request ID", async ({
  db,
}) => {
  const w = await world(db);
  const id = await w.makeLead();
  const requestId = randomUUID();
  const input = { id, key: "attempt", work: noAnswer };
  const first = await db.store.workLead(w.agent, input, requestId);
  expect(await db.store.workLead(w.agent, input, randomUUID())).toEqual(first);
  expect(
    await db.rows(
      "SELECT detail->>'actorId' AS actor, detail->>'requestId' AS request FROM activities WHERE lead_id=$1 AND kind='attempt'",
      [id],
    ),
  ).toEqual([{ actor: w.agent.userId, request: requestId }]);
  expect(
    await db.rows(
      "SELECT actor_id, request_id FROM audit_log WHERE subject_id=$1 AND action='leadWorked'",
      [id],
    ),
  ).toEqual([{ actor_id: w.agent.userId, request_id: requestId }]);
  await expect(w.work(w.agent, id, spoke, "attempt")).rejects.toMatchObject({
    code: "idempotencyConflict",
  });
});

test("two wins collide and create one account and one closing activity", async ({ db }) => {
  const w = await world(db);
  const id = await w.makeLead();
  await w.work(w.agent, id, spoke);
  await db.gate.close();
  const pending = Promise.all([
    w.work(w.agent, id, won, "win-a"),
    w.work(w.agent, id, won, "win-b"),
  ]);
  try {
    await db.gate.waitForWaiters(2);
  } finally {
    await db.gate.open();
  }
  const results = await pending;
  expect(results[0]).toEqual(results[1]);
  expect(await db.rows("SELECT count(*)::int AS count FROM accounts")).toEqual([{ count: 1 }]);
  expect(await db.rows("SELECT owner_id, team_id FROM accounts")).toEqual([
    { owner_id: w.agent.userId, team_id: w.team },
  ]);
  expect(
    await db.rows("SELECT count(*)::int AS count FROM activities WHERE kind='closure'"),
  ).toEqual([{ count: 1 }]);
  const detail = await db.store.getLead(w.agent, id);
  expect(detail.lifecycle.state).toMatchObject({ status: "won", accountId: results[0].accountId });
  expect(db.transactions.some((report) => report.committed && report.attempts > 1)).toBe(true);
  const before = await db.counts();
  await w.work(w.agent, id, won, "win-a");
  expect(await db.counts()).toEqual(before);
});

test("winning races reassignment with a valid owner and true activity order", async ({ db }) => {
  const w = await world(db);
  const id = await w.makeLead();
  await w.work(w.agent, id, spoke);
  await db.gate.close();
  const pending = Promise.allSettled([
    w.work(w.agent, id, won),
    db.store.reassignLead(
      w.manager,
      id,
      { ownerId: w.other.userId, teamId: w.otherTeam },
      randomUUID(),
    ),
  ]);
  try {
    await db.gate.waitForWaiters(2);
  } finally {
    await db.gate.open();
  }
  const results = await pending;
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const detail = await db.store.getLead(w.manager, id);
  const state = detail.lifecycle.state;
  if (state.status === "won") {
    expect(state.assignee.ownerId).toBe(w.agent.userId);
    expect(detail.timeline[0]?.kind).toBe("closure");
    expect(await db.rows("SELECT count(*)::int AS count FROM accounts")).toEqual([{ count: 1 }]);
  } else {
    expect(state).toMatchObject({ status: "working", assignee: { ownerId: w.other.userId } });
    expect(detail.timeline[0]?.kind).toBe("assignment");
    expect(await db.rows("SELECT count(*)::int AS count FROM accounts")).toEqual([{ count: 0 }]);
  }
  expect(detail.timeline[0]?.sequence).toBeGreaterThan(detail.timeline[1]?.sequence ?? 0n);
  const rejected = results.find((result) => result.status === "rejected");
  expect(rejected).toMatchObject({
    reason: { code: state.status === "won" ? "conflict" : "accessDenied" },
  });
});

test("closing races fresh intake and records one of the permitted serial histories", async ({
  db,
}) => {
  const w = await world(db);
  const email = "returning@example.com";
  const id = await w.makeLead(w.agent, email);
  await w.work(w.agent, id, noAnswer);
  await db.gate.close("leads");
  const pending = Promise.all([
    w.work(w.agent, id, lost),
    db.store.intake(submissionExample({ email, externalId: "second-enquiry" })),
  ]);
  try {
    await db.gate.waitForWaiters(2);
  } finally {
    await db.gate.open();
  }
  const [, intake] = await pending;
  const detail = await db.store.getLead(w.manager, id);
  const chronological = [...detail.timeline].reverse();
  const kinds = chronological.map((activity) => activity.kind);
  if (intake.outcome.kind === "leadReopened") {
    expect(detail.lifecycle.state).toEqual({ status: "new" });
    expect(detail.lostNote).toBeNull();
    expect(kinds.slice(-3)).toEqual(["closure", "intake", "statusChange"]);
  } else {
    expect(intake.outcome.kind).toBe("attachedToOpenLead");
    expect(detail.lifecycle.state.status).toBe("lost");
    expect(detail.lostNote).toBe("Chose a closer school");
    expect(kinds.slice(-2)).toEqual(["intake", "closure"]);
  }
  expect(await db.rows("SELECT count(*)::int AS count FROM leads WHERE email=$1", [email])).toEqual(
    [{ count: 1 }],
  );
});

test.for([
  ["Asia/Tokyo", "2026-11-16T16:00:00Z", "2026-11-17T01:00:00Z", "2026-11-17T15:00:00Z"],
  ["America/Los_Angeles", "2026-11-17T01:00:00Z", "2026-11-17T07:00:00Z", "2026-11-17T08:00:00Z"],
] as const)(
  "the PostgreSQL queue respects the local day in %s",
  async ([zone, now, today, tomorrow], { db }) => {
    const w = await world(db);
    const ids = await Promise.all([w.makeLead(), w.makeLead(), w.makeLead(), w.makeLead()]);
    for (const [id, when] of [
      [ids[0], new Date(new Date(now).getTime() - 1)],
      [ids[1], new Date(today)],
      [ids[2], new Date(tomorrow)],
    ] as const) {
      await db.rows(
        "UPDATE leads SET status='working', stage='callBack', call_back_at=$1 WHERE id=$2",
        [when, id],
      );
    }
    const queue = await db.store.workQueue(w.agent, {
      agentId: w.agent.userId,
      at: new Date(now),
      timeZone: zone,
      limit: 100,
    });
    expect(queue.overdueCallbacks.map((lead) => lead.id)).toEqual([ids[0]]);
    expect(queue.dueToday.map((lead) => lead.id)).toEqual([ids[1]]);
    expect(queue.notYetCalled.map((lead) => lead.id)).toEqual([ids[3]]);
    expect(queue.later.map((lead) => lead.id)).toEqual([ids[2]]);
    expect(queue.counts.later).toBe(1);
    expect(queue.notYetCalled[0]).toMatchObject({
      campaign: "Evening course",
      noAnswerCount: 0,
      callbackAt: null,
    });
  },
);

test("notes, callback moves and clearing, and all closing decisions keep their history", async ({
  db,
}) => {
  const w = await world(db);
  const id = await w.makeLead();
  await w.work(w.agent, id, { kind: "note", note: "Asked for evening classes" });
  await w.work(w.agent, id, { kind: "callback", change: { kind: "set", at: FUTURE } });
  const later = new Date(FUTURE.getTime() + 3600000);
  await w.work(w.agent, id, { kind: "callback", change: { kind: "set", at: later } });
  expect((await db.store.getLead(w.agent, id)).lifecycle.state).toMatchObject({
    stage: { at: later },
  });
  await w.work(w.agent, id, { kind: "callback", change: { kind: "clear" } });
  const detail = await db.store.getLead(w.agent, id);
  expect(detail.lifecycle.state).toMatchObject({ status: "working", stage: { kind: "ready" } });
  expect(detail.contactedAt).toBeNull();
  expect(detail.custody.receivedFrom?.source).toBe("webForm");
  expect(detail.custody.assignedBy?.id).toBe(w.manager.userId);
  expect(detail.custody.heldBy?.id).toBe(w.agent.userId);
  expect(detail.attribution?.campaign).toBe("Evening course");
  expect(detail.timeline.slice(0, 4).map((activity) => activity.kind)).toEqual([
    "callback",
    "callback",
    "callback",
    "note",
  ]);
  for (const reason of ["duplicate", "wrongNumber", "doNotContact"] as const) {
    const deadId = await w.makeLead();
    if (reason === "wrongNumber") await w.work(w.agent, deadId, noAnswer);
    await w.work(w.agent, deadId, { kind: "close", closing: { kind: "dead", reason } });
    expect((await db.store.getLead(w.agent, deadId)).lifecycle.state).toMatchObject({
      status: "dead",
      reason,
    });
    await expect(w.work(w.agent, deadId, noAnswer)).rejects.toMatchObject({ code: "leadClosed" });
  }
  await expect(
    w.work(w.agent, id, {
      kind: "callback",
      change: { kind: "set", at: new Date("2000-01-01T00:00:00Z") },
    }),
  ).rejects.toMatchObject({ code: "callbackInPast" });
  await w.work(w.agent, id, won);
  expect((await db.store.getLead(w.agent, id)).lifecycle.state.status).toBe("won");
  const untouched = await w.makeLead();
  await expect(w.work(w.agent, untouched, won)).rejects.toMatchObject({
    code: "invalidTransition",
  });
});

for (const role of ROLES) {
  test(`${role} has the existing read and edit scope on every new operation`, async ({ db }) => {
    const w = await world(db);
    const actor = await w.makeActor(role);
    const own = await w.makeLead(actor);
    const teammate = await w.makeLead(w.agent);
    const outside = await w.makeLead(w.other);
    const management = ["owner", "admin", "manager"].includes(role);
    for (const [id, canRead, canEdit] of [
      [own, role !== "accountant", role !== "accountant"],
      [teammate, management || role === "teamLead", management],
      [outside, management, management],
    ] as const) {
      const read = db.store.getLead(actor, id);
      if (canRead) await expect(read).resolves.toMatchObject({ id });
      else await expect(read).rejects.toMatchObject({ code: "accessDenied" });
      for (const command of [
        noAnswer,
        spoke,
        { kind: "note", note: "A note" },
        { kind: "callback", change: { kind: "set", at: FUTURE } },
        { kind: "callback", change: { kind: "clear" } },
      ] as const) {
        const result = w.work(actor, id, command);
        if (canEdit) await expect(result).resolves.toMatchObject({ id });
        else await expect(result).rejects.toMatchObject({ code: "accessDenied" });
      }
      for (const command of [
        won,
        lost,
        { kind: "close", closing: { kind: "dead", reason: "duplicate" } },
      ] as const) {
        const closeId = await w.makeLead(id === own ? actor : id === teammate ? w.agent : w.other);
        const owner = id === own ? actor : id === teammate ? w.agent : w.other;
        if (canEdit) await w.work(actor, closeId, noAnswer);
        else if (owner.role !== "accountant") await w.work(owner, closeId, noAnswer);
        const result = w.work(actor, closeId, command);
        if (canEdit) await expect(result).resolves.toMatchObject({ id: closeId });
        else await expect(result).rejects.toMatchObject({ code: "accessDenied" });
      }
    }
    for (const [target, admitted] of [
      [w.agent, management || role === "teamLead"],
      [w.other, management],
    ] as const) {
      const queue = db.store.workQueue(actor, {
        agentId: target.userId,
        at: AT,
        timeZone: "UTC",
        limit: 100,
      });
      if (admitted) await expect(queue).resolves.toHaveProperty("counts");
      else await expect(queue).rejects.toMatchObject({ code: "accessDenied" });
    }
    const funnel = db.store.campaignFunnel(actor);
    if (management) await expect(funnel).resolves.toHaveProperty("rows");
    else await expect(funnel).rejects.toMatchObject({ code: "accessDenied" });
  });
}

test("working reloads a revoked role inside its transaction, including a replay", async ({
  db,
}) => {
  const w = await world(db);
  const id = await w.makeLead();
  await w.work(w.manager, id, noAnswer, "old-manager");
  await db.rows("UPDATE users SET role='accountant' WHERE id=$1", [w.manager.userId]);
  await expect(w.work(w.manager, id, spoke)).rejects.toMatchObject({ code: "accessDenied" });
  await expect(w.work(w.manager, id, noAnswer, "old-manager")).rejects.toMatchObject({
    code: "accessDenied",
  });
});

test("the funnel counts original leads once and keeps missing contact history unknown", async ({
  db,
}) => {
  const w = await world(db);
  const id = await w.makeLead(w.agent, "funnel@example.com");
  await w.work(w.agent, id, noAnswer);
  await w.work(w.agent, id, won);
  await db.store.intake(
    submissionExample({
      email: "funnel@example.com",
      externalId: "repeat",
      campaign: "Another campaign",
    }),
  );
  await db.store.intake(
    submissionExample({
      email: "waiting@example.com",
      externalId: "waiting",
      campaign: "Evening course",
    }),
  );
  const historical = await w.makeLead();
  await db.rows("UPDATE leads SET work_history_known=false WHERE id=$1", [historical]);
  expect((await db.store.campaignFunnel(w.manager)).rows).toEqual([
    {
      campaign: "Evening course",
      source: "webForm",
      received: 3,
      unassigned: 1,
      knownContacted: 0,
      contactUnknown: 1,
      contacted: null,
      won: 1,
      conversion: 1 / 3,
    },
  ]);
  const historicalDetail = await db.store.getLead(w.manager, historical);
  expect(historicalDetail.contactedAt).toBeNull();
  expect(historicalDetail.noAnswerCount).toBeNull();
  const queue = await db.store.workQueue(w.agent, {
    agentId: w.agent.userId,
    at: AT,
    timeZone: "UTC",
    limit: 100,
  });
  expect(queue.notYetCalled.map((lead) => lead.id)).toContain(historical);
});

test("account lists share ledger balances and withhold them from lead workers", async ({ db }) => {
  const w = await world(db);
  const id = await w.makeLead();
  await w.work(w.agent, id, spoke);
  const result = await w.work(w.agent, id, won);
  if (result.accountId === null) throw new Error("The win created no account");
  const money = { minor: 12500n, currency: "GBP" } as const;
  const payment = await db.store.createPayment(
    w.agent,
    { key: "account-balance", accountId: result.accountId, money, kind: "first", mode: "normal" },
    0,
    randomUUID(),
  );
  await db.store.receivePaymentWebhook({
    eventId: randomUUID(),
    paymentId: payment.id,
    payloadHash: "account-balance",
    observed: { status: "completed", money },
  });
  const ledger = await db.store.accountLedger(w.manager, result.accountId);
  for (const role of ROLES) {
    const actor = role === "agent" ? w.agent : await w.makeActor(role);
    const { items } = await db.store.listAccounts(actor, { limit: 100 });
    expect(items).toHaveLength(1);
    expect(items[0]?.owner?.id).toBe(w.agent.userId);
    expect(items[0]?.person?.id).toBe(id);
    expect(items[0]?.paymentCount).toBe(1);
    expect(items[0]?.paymentInProgress).toBeNull();
    expect(items[0]?.balances).toEqual(
      role === "agent" || role === "teamLead"
        ? null
        : ledger.balances.map(({ currency, balance }) => ({ currency, balance })),
    );
  }
  expect(await db.store.listAccounts(w.other, { limit: 100 })).toEqual({ items: [], total: 0 });
});

test("the database refuses winning without an account", async ({ db }) => {
  const w = await world(db);
  const id = await w.makeLead();
  await expect(
    db.rows("UPDATE leads SET status='won', stage=NULL, account_id=NULL WHERE id=$1", [id]),
  ).rejects.toMatchObject({ code: "23514", constraint: "leads_state_shape" });
});

test("an intake attachment keeps a pool distribution preview valid", async ({ db }) => {
  const w = await world(db);
  const first = await db.store.intake(
    submissionExample({ email: "preview@example.com", externalId: "preview-first" }),
  );
  if (!("leadId" in first.outcome)) throw new Error("Expected a pool lead");
  const id = first.outcome.leadId;
  const preview = await db.store.previewDistribution(w.manager, {
    leadIds: [id],
    agents: [{ ownerId: w.agent.userId, teamId: w.team }],
    excludePreviousOwner: false,
  });
  await db.store.intake(
    submissionExample({ email: "preview@example.com", externalId: "preview-attach" }),
  );
  await expect(
    db.store.submitDistribution(
      w.manager,
      { previewId: preview.id, fingerprint: preview.fingerprint, key: "preview-submit" },
      randomUUID(),
    ),
  ).resolves.toMatchObject({ changed: true });
});

test("worked, reassigned and reopened leads each stay in one queue group", async ({ db }) => {
  const w = await world(db);
  const worked = await w.makeLead();
  const moved = await w.makeLead();
  const reopened = await w.makeLead(w.agent, "reopened@example.com");
  for (const id of [worked, moved, reopened]) await w.work(w.agent, id, noAnswer);
  await db.store.reassignLead(
    w.manager,
    moved,
    { ownerId: w.other.userId, teamId: w.otherTeam },
    randomUUID(),
  );
  await w.work(w.agent, reopened, lost);
  await db.store.intake(submissionExample({ email: "reopened@example.com", externalId: "reopen" }));
  await db.store.assignPool(
    w.manager,
    [reopened],
    { ownerId: w.other.userId, teamId: w.otherTeam },
    randomUUID(),
  );
  const queue = (actor: Actor) =>
    db.store.workQueue(actor, { agentId: actor.userId, at: AT, timeZone: "UTC", limit: 100 });
  expect(await queue(w.agent)).toMatchObject({
    noCallbackSet: [{ id: worked }],
    counts: { noCallbackSet: 1 },
  });
  expect((await queue(w.other)).notYetCalled.map((lead) => lead.id)).toEqual([reopened, moved]);
  expect((await queue(w.other)).notYetCalled.find((lead) => lead.id === moved)?.noAnswerCount).toBe(
    1,
  );
});

test("timeline attempts carry dated callbacks, entry counts and object snapshots", async ({
  db,
}) => {
  const w = await world(db);
  const id = await w.makeLead();
  await w.work(w.agent, id, noAnswer);
  await w.work(w.agent, id, {
    ...noAnswer,
    attempt: { ...noAnswer.attempt, callback: { kind: "set", at: FUTURE } },
  });
  const entries = (await db.store.getLead(w.agent, id)).timeline.filter(
    (entry) => entry.kind === "attempt",
  );
  expect(entries[0]?.summary).toMatchObject({ callbackAt: FUTURE, noAnswerCount: 2 });
  expect(entries[1]?.summary).toMatchObject({ callbackAt: null, noAnswerCount: 1 });
  expect(
    await db.rows(
      "SELECT jsonb_typeof(detail->'before') AS before, jsonb_typeof(detail->'after') AS after FROM activities WHERE lead_id=$1 AND detail ? 'before'",
      [id],
    ),
  ).toEqual([
    { before: "object", after: "object" },
    { before: "object", after: "object" },
    { before: "object", after: "object" },
  ]);
});

test("queue rows return intake source and the current assignment time", async ({ db }) => {
  const w = await world(db);
  const id = await w.makeLead();
  await db.store.reassignLead(
    w.manager,
    id,
    { ownerId: w.other.userId, teamId: w.otherTeam },
    randomUUID(),
  );
  const detail = await db.store.getLead(w.other, id);
  const queue = await db.store.workQueue(w.other, {
    agentId: w.other.userId,
    at: AT,
    timeZone: "UTC",
    limit: 100,
  });
  expect(queue.notYetCalled[0]).toMatchObject({
    id,
    source: "webForm",
    assignedAt: detail.custody.heldBy?.since,
  });
});

test("wrong number requires an attempt in the current assignment", async ({ db }) => {
  const w = await world(db);
  const id = await w.makeLead();
  const dead: LeadWork = { kind: "close", closing: { kind: "dead", reason: "wrongNumber" } };
  await expect(w.work(w.agent, id, dead)).rejects.toMatchObject({
    code: "wrongNumberNeedsAnAttempt",
    message:
      "Try contacting this lead in its current assignment before marking it as a wrong number.",
  });
  await w.work(w.agent, id, noAnswer);
  await db.store.reassignLead(
    w.manager,
    id,
    { ownerId: w.other.userId, teamId: w.otherTeam },
    randomUUID(),
  );
  await expect(w.work(w.other, id, dead)).rejects.toMatchObject({
    code: "wrongNumberNeedsAnAttempt",
  });
  await w.work(w.other, id, noAnswer);
  await expect(w.work(w.other, id, dead)).resolves.toMatchObject({ id });
});

test("clearing an unset callback refuses without writing history", async ({ db }) => {
  const w = await world(db);
  const id = await w.makeLead();
  for (const attempted of [false, true]) {
    if (attempted) await w.work(w.agent, id, noAnswer);
    const counts = await db.counts();
    await expect(
      w.work(w.agent, id, { kind: "callback", change: { kind: "clear" } }),
    ).rejects.toMatchObject({
      code: "callbackNotSet",
      message: "This lead has no callback to clear.",
    });
    expect(await db.counts()).toEqual(counts);
  }
  await w.work(w.agent, id, { kind: "callback", change: { kind: "set", at: FUTURE } });
  await w.work(w.agent, id, {
    ...noAnswer,
    attempt: { ...noAnswer.attempt, callback: { kind: "clear" } },
  });
  expect((await db.store.getLead(w.agent, id)).noAnswerCount).toBe(2);
});

test("the app role cannot leave won or dead or reopen lost without intake", async ({ db }) => {
  const w = await world(db);
  for (const closing of [
    won,
    lost,
    { kind: "close", closing: { kind: "dead", reason: "duplicate" } },
  ] as const) {
    const id = await w.makeLead();
    await w.work(w.agent, id, noAnswer);
    await w.work(w.agent, id, closing);
    for (const sql of [
      "UPDATE leads SET status='working',stage='ready',account_id=NULL,lost_note=NULL,dead_reason=NULL WHERE id=$1",
      "UPDATE leads SET status='new',stage=NULL,previous_owner_id=owner_id,owner_id=NULL,team_id=NULL,account_id=NULL,lost_note=NULL,dead_reason=NULL WHERE id=$1",
    ]) {
      await expect(db.rows(sql, [id])).rejects.toMatchObject({ code: "23514" });
    }
    expect((await db.store.getLead(w.manager, id)).lifecycle.state.status).toBe(
      closing.closing.kind,
    );
  }
});

test("the funnel separates equal campaign names by intake source", async ({ db }) => {
  const w = await world(db);
  for (const source of ["metaLeadAds", "webForm", "csv"] as const) {
    const intake = await db.store.intake(
      submissionExample({
        email: `${source}@example.com`,
        externalId: source,
        source,
        campaign: source === "csv" ? null : "Evening",
      }),
    );
    if (source === "metaLeadAds" && "leadId" in intake.outcome) {
      await w.work(w.manager, intake.outcome.leadId, {
        kind: "close",
        closing: { kind: "dead", reason: "duplicate" },
      });
    }
  }
  const funnel = await db.store.campaignFunnel(w.manager);
  expect(funnel).toMatchObject({ campaignCount: 1, otherSourceCount: 2 });
  expect(funnel.rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ source: "metaLeadAds", campaign: "Evening", received: 1 }),
      expect.objectContaining({ source: "webForm", campaign: "Evening", received: 1 }),
      expect.objectContaining({ source: "csv", campaign: null, received: 1 }),
    ]),
  );
});

test("account lists sort by person name with a scoped total and payment summary", async ({
  db,
}) => {
  const w = await world(db);
  const accountIds = [];
  for (const name of ["Ada", "Zoe"]) {
    const id = await w.makeLead();
    await db.store.editLead(w.manager, id, { name, phone: null });
    await w.work(w.agent, id, noAnswer);
    accountIds.push((await w.work(w.agent, id, won)).accountId);
  }
  const accountId = accountIds[0];
  if (!accountId) throw new Error("No account");
  await db.store.createPayment(
    w.agent,
    {
      key: "progress",
      accountId,
      money: { minor: 100n, currency: "GBP" },
      kind: "first",
      mode: "normal",
    },
    0,
    randomUUID(),
  );
  for (const actor of [w.manager, w.agent]) {
    const result = await db.store.listAccounts(actor, { limit: 1 });
    expect(result.total).toBe(2);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: accountId,
      campaign: "Evening course",
      person: { name: "Ada" },
      paymentCount: 0,
      paymentInProgress: { status: "checkoutCreated" },
    });
    if (actor === w.agent) expect(result.items[0]?.balances).toBeNull();
  }
  expect(await db.store.listAccounts(w.other, { limit: 1 })).toEqual({ items: [], total: 0 });
});

test("the queue filters an admitted agent's leads by the viewer's selected team", async ({
  db,
}) => {
  const w = await world(db);
  const lead = await w.makeActor("teamLead");
  const ownTeam = await w.makeLead();
  const otherTeam = await w.makeLead();
  await db.ownerRows("INSERT INTO memberships(user_id,team_id) VALUES ($1,$2)", [
    w.agent.userId,
    w.otherTeam,
  ]);
  await db.store.reassignLead(
    w.manager,
    otherTeam,
    { ownerId: w.agent.userId, teamId: w.otherTeam },
    randomUUID(),
  );
  const queue = await db.store.workQueue(lead, {
    agentId: w.agent.userId,
    at: AT,
    timeZone: "UTC",
    limit: 100,
  });
  expect(queue.notYetCalled.map((item) => item.id)).toEqual([ownTeam]);
});

test("a note does not count as an attempt in the queue", async ({ db }) => {
  const w = await world(db);
  const id = await w.makeLead();
  await w.work(w.agent, id, { kind: "note", note: "Call after work" });
  const queue = await db.store.workQueue(w.agent, {
    agentId: w.agent.userId,
    at: AT,
    timeZone: "UTC",
    limit: 100,
  });
  expect(queue.notYetCalled.map((item) => item.id)).toEqual([id]);
  expect(queue.notYetCalled[0]?.noAnswerCount).toBe(0);
});

test("a note on a closed lead is refused without history", async ({ db }) => {
  const w = await world(db);
  const id = await w.makeLead();
  await w.work(w.agent, id, noAnswer);
  await w.work(w.agent, id, lost);
  const before = await db.counts();
  await expect(w.work(w.agent, id, { kind: "note", note: "Too late" })).rejects.toMatchObject({
    code: "leadClosed",
  });
  expect(await db.counts()).toEqual(before);
});

test("a lost close saves its written reason and one closure activity", async ({ db }) => {
  const w = await world(db);
  const id = await w.makeLead();
  await w.work(w.agent, id, noAnswer);
  await w.work(w.agent, id, lost);
  const detail = await db.store.getLead(w.agent, id);
  expect(detail.lifecycle.state).toMatchObject({ status: "lost", reason: "Chose a closer school" });
  expect(detail.lostNote).toBe("Chose a closer school");
  const closures = detail.timeline.filter((item) => item.kind === "closure");
  expect(closures).toHaveLength(1);
  expect(closures[0]?.detail).toMatchObject({
    actorId: w.agent.userId,
    closing: { kind: "lost", note: "Chose a closer school" },
  });
});

test("the funnel counts reopened and reassigned leads once under their creating intake", async ({
  db,
}) => {
  const w = await world(db);
  const reopened = await w.makeLead(w.agent, "funnel-reopened@example.com");
  const moved = await w.makeLead();
  await w.work(w.agent, reopened, noAnswer);
  await w.work(w.agent, reopened, lost);
  await db.store.intake(
    submissionExample({
      email: "funnel-reopened@example.com",
      externalId: "new-intake",
      source: "metaLeadAds",
      campaign: "Different",
    }),
  );
  await db.store.reassignLead(
    w.manager,
    moved,
    { ownerId: w.other.userId, teamId: w.otherTeam },
    randomUUID(),
  );
  expect((await db.store.campaignFunnel(w.manager)).rows).toEqual([
    expect.objectContaining({
      campaign: "Evening course",
      source: "webForm",
      received: 2,
      unassigned: 1,
      won: 0,
    }),
  ]);
});

test("a team lead must select a team before listing accounts", async ({ db }) => {
  const w = await world(db);
  const lead = await w.makeActor("teamLead");
  await db.ownerRows("INSERT INTO memberships(user_id,team_id,is_lead) VALUES ($1,$2,true)", [
    lead.userId,
    w.otherTeam,
  ]);
  await expect(
    db.store.listAccounts({ ...lead, team: null }, { limit: 100 }),
  ).rejects.toMatchObject({ code: "teamSelectionRequired" });
});
