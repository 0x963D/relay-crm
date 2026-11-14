import type { IntakeResult, LeadLifecycle } from "@relay/domain";
import { submissionExample, type SubmissionFields } from "@relay/domain/testing";
import { describe, expect } from "vitest";
import { test, type TestDatabase } from "../src/testing/index.ts";
import { isStaleSnapshot } from "../src/tx.ts";

const POOLED: LeadLifecycle = {
  state: { status: "new" },
  firstAssignedAt: null,
  previousOwnerId: null,
};

async function race(
  db: TestDatabase,
  submissions: readonly SubmissionFields[],
): Promise<readonly IntakeResult[]> {
  await db.gate.close();
  const racing = Promise.all(
    submissions.map((fields) => db.store.intake(submissionExample(fields))),
  );
  await db.gate.waitForWaiters(submissions.length);
  await db.gate.open();
  return racing;
}

function outcomes(results: readonly IntakeResult[]): readonly string[] {
  return results.map((result) => result.outcome.kind).sort();
}

function retried(db: TestDatabase): number {
  return db.transactions.filter((transaction) => transaction.attempts > 1).length;
}

async function seedLostLead(db: TestDatabase, email: string): Promise<void> {
  const assignee = { ownerId: await db.seedUser("agent"), teamId: await db.seedTeam("sales") };
  await db.seedLead({
    email,
    lifecycle: {
      state: { status: "lost", assignee, reason: "noBudget" },
      firstAssignedAt: new Date("2026-02-01T08:00:00.000Z"),
      previousOwnerId: null,
    },
  });
}

describe("two intakes that decide on the same stale snapshot", () => {
  test("for one new email: one lead is created and the other attaches to it", async ({ db }) => {
    const results = await race(db, [
      { externalId: "a", email: "Ana@Example.com" },
      { externalId: "b", email: " ana@example.com" },
    ]);

    expect(outcomes(results)).toEqual(["attachedToOpenLead", "leadCreated"]);
    expect(await db.counts()).toEqual({ leads: 1, intakeEvents: 2, activities: 2 });
    expect(retried(db), "the loser ran again").toBeGreaterThanOrEqual(1);
  });

  test("for one external ID: one event is recorded and the other replays it", async ({ db }) => {
    const [first, second] = await race(db, [{ externalId: "meta-1" }, { externalId: "meta-1" }]);

    expect([first?.replayed, second?.replayed].sort()).toEqual([false, true]);
    expect(second?.eventId).toBe(first?.eventId);
    expect(second?.outcome).toEqual(first?.outcome);
    expect(await db.counts()).toEqual({ leads: 1, intakeEvents: 1, activities: 1 });
  });

  test("for one external ID with no email: the rejection is recorded once", async ({ db }) => {
    const [first, second] = await race(db, [
      { externalId: "bad-1", email: null },
      { externalId: "bad-1", email: null },
    ]);

    expect([first?.replayed, second?.replayed].sort()).toEqual([false, true]);
    expect(second?.eventId).toBe(first?.eventId);
    expect(await db.counts()).toEqual({ leads: 0, intakeEvents: 1, activities: 0 });
  });

  test("for one closed lead: it reopens once and the other attaches", async ({ db }) => {
    await seedLostLead(db, "ana@example.com");

    const results = await race(db, [{ externalId: "a" }, { externalId: "b" }]);

    expect(outcomes(results)).toEqual(["attachedToOpenLead", "leadReopened"]);
    expect(await db.rows("SELECT status, owner_id FROM leads")).toEqual([
      { status: "new", owner_id: null },
    ]);
    expect(
      await db.rows("SELECT kind, count(*)::int AS n FROM activities GROUP BY kind ORDER BY kind"),
    ).toEqual([
      { kind: "intake", n: 2 },
      { kind: "statusChange", n: 1 },
    ]);
    expect(retried(db), "the second reopen ran again").toBeGreaterThanOrEqual(1);
  });

  test("for one open lead: both attach and the lead does not change", async ({ db }) => {
    await db.seedLead({ email: "ana@example.com", lifecycle: POOLED });

    const results = await race(db, [{ externalId: "a" }, { externalId: "b" }]);

    expect(outcomes(results)).toEqual(["attachedToOpenLead", "attachedToOpenLead"]);
    expect(await db.rows("SELECT status, owner_id FROM leads")).toEqual([
      { status: "new", owner_id: null },
    ]);
    expect(await db.counts()).toEqual({ leads: 1, intakeEvents: 2, activities: 2 });
  });

  test("for one open lead and one external ID: one attaches and the other replays", async ({
    db,
  }) => {
    await db.seedLead({ email: "ana@example.com", lifecycle: POOLED });

    const [first, second] = await race(db, [{ externalId: "same" }, { externalId: "same" }]);

    expect([first?.replayed, second?.replayed].sort()).toEqual([false, true]);
    expect(second?.eventId).toBe(first?.eventId);
    expect(await db.counts()).toEqual({ leads: 1, intakeEvents: 1, activities: 1 });
  });
});

async function deliver(db: TestDatabase, fields: SubmissionFields): Promise<IntakeResult> {
  const submission = submissionExample(fields);
  for (let redelivery = 0; ; redelivery += 1) {
    try {
      return await db.store.intake(submission);
    } catch (error) {
      if (redelivery === 3 || !isStaleSnapshot(error)) throw error;
    }
  }
}

describe("a burst with no gate", () => {
  const BURST = 12;
  const indexes = Array.from({ length: BURST }, (_, index) => index);

  test("of twelve intakes for one email leaves one lead and twelve events", async ({ db }) => {
    const results = await Promise.all(
      indexes.map((index) => deliver(db, { externalId: `burst-${String(index)}` })),
    );

    expect(outcomes(results)).toEqual([
      ...Array.from({ length: BURST - 1 }, () => "attachedToOpenLead"),
      "leadCreated",
    ]);
    expect(new Set(results.map((result) => result.eventId)).size).toBe(BURST);
    expect(await db.counts()).toEqual({ leads: 1, intakeEvents: BURST, activities: BURST });
  });

  test("of twelve deliveries of one external ID leaves one lead and one event", async ({ db }) => {
    const results = await Promise.all(indexes.map(() => deliver(db, { externalId: "meta-1" })));

    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(new Set(results.map((result) => result.eventId)).size).toBe(1);
    expect(outcomes(results)).toEqual(Array.from({ length: BURST }, () => "leadCreated"));
    expect(await db.counts()).toEqual({ leads: 1, intakeEvents: 1, activities: 1 });
  });

  test("of intakes for twelve different people creates twelve leads", async ({ db }) => {
    const results = await Promise.all(
      indexes.map((index) =>
        deliver(db, {
          externalId: `person-${String(index)}`,
          email: `person-${String(index)}@example.com`,
        }),
      ),
    );

    expect(outcomes(results)).toEqual(Array.from({ length: BURST }, () => "leadCreated"));
    expect(await db.counts()).toEqual({ leads: BURST, intakeEvents: BURST, activities: BURST });
  });
});
