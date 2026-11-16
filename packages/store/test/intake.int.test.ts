import type {
  Actor,
  Assignment,
  IntakeResult,
  LeadId,
  LeadLifecycle,
  LeadState,
} from "@relay/domain";
import { submissionExample } from "@relay/domain/testing";
import { describe, expect } from "vitest";
import { test, type TestDatabase } from "../src/testing/index.ts";

const RECEIVED = new Date("2026-03-02T09:00:00.000Z");
const ASSIGNED = new Date("2026-02-01T08:00:00.000Z");

async function ownerOf(db: TestDatabase): Promise<Actor> {
  return { userId: await db.seedUser("owner"), role: "owner", team: null };
}

function leadOf(result: IntakeResult): LeadId {
  if (!("leadId" in result.outcome)) throw new Error("This outcome has no lead");
  return result.outcome.leadId;
}

async function seedHeldLead(
  db: TestDatabase,
  email: string,
  build: (assignee: Assignment) => LeadState,
) {
  const assignee = { ownerId: await db.seedUser("agent"), teamId: await db.seedTeam("sales") };
  const lifecycle: LeadLifecycle = {
    state: build(assignee),
    firstAssignedAt: ASSIGNED,
    previousOwnerId: null,
  };
  return { assignee, lifecycle, leadId: await db.seedLead({ email, lifecycle }) };
}

function ledger(db: TestDatabase) {
  return db.rows(
    `SELECT source, external_id, email, name, campaign, outcome, lead_id, account_id, raw
     FROM intake_events ORDER BY received_at, id`,
  );
}

function timeline(db: TestDatabase) {
  return db.rows(
    `SELECT kind, lead_id, account_id, intake_event_id, detail FROM activities ORDER BY kind, id`,
  );
}

describe("a new person", () => {
  test("becomes a pooled lead at its canonical address, with the original record in the ledger", async ({
    db,
  }) => {
    const raw = { email: "Ana@Example.com", utm: { campaign: "spring" }, consent: true };
    const result = await db.store.intake(
      submissionExample({
        source: "webForm",
        externalId: "form-1",
        email: "Ana@Example.com",
        name: "Ana Silva",
        campaign: "spring",
        receivedAt: RECEIVED,
        raw,
      }),
    );

    const leadId = leadOf(result);
    expect(result).toMatchObject({ replayed: false, outcome: { kind: "leadCreated" } });

    expect(await db.store.listLeads(await ownerOf(db), { limit: 10 })).toEqual([
      {
        id: leadId,
        email: "ana@example.com",
        name: "Ana Silva",
        phone: null,
        lifecycle: { state: { status: "new" }, firstAssignedAt: null, previousOwnerId: null },
        createdAt: RECEIVED,
        origin: { source: "webForm", campaign: "spring" },
      },
    ]);
    expect(await ledger(db)).toEqual([
      {
        source: "webForm",
        external_id: "form-1",
        email: "ana@example.com",
        name: "Ana Silva",
        campaign: "spring",
        outcome: "leadCreated",
        lead_id: leadId,
        account_id: null,
        raw,
      },
    ]);
    expect(await timeline(db)).toEqual([
      {
        kind: "intake",
        lead_id: leadId,
        account_id: null,
        intake_event_id: result.eventId,
        detail: null,
      },
    ]);
  });

  test("is one person however the email is typed", async ({ db }) => {
    const first = await db.store.intake(
      submissionExample({ externalId: "a", email: "Ana@Example.com" }),
    );
    const second = await db.store.intake(
      submissionExample({ externalId: "b", email: "  ana@EXAMPLE.com " }),
    );

    expect(second.outcome).toEqual({ kind: "attachedToOpenLead", leadId: leadOf(first) });
    expect(await db.counts()).toEqual({ leads: 1, intakeEvents: 2, activities: 2 });
  });
});

describe("idempotency", () => {
  test("replays the first outcome for a repeated external ID and writes nothing", async ({
    db,
  }) => {
    const first = await db.store.intake(submissionExample({ externalId: "meta-1" }));
    const again = await db.store.intake(
      submissionExample({ externalId: "meta-1", email: "someone.else@example.com", name: "Other" }),
    );

    expect(again).toEqual({ ...first, replayed: true });
    expect(await db.counts()).toEqual({ leads: 1, intakeEvents: 1, activities: 1 });
  });

  test("keeps external IDs of different sources apart", async ({ db }) => {
    await db.store.intake(submissionExample({ source: "csv", externalId: "7" }));
    const other = await db.store.intake(
      submissionExample({ source: "metaLeadAds", externalId: "7" }),
    );

    expect(other.replayed).toBe(false);
    expect(other.outcome.kind).toBe("attachedToOpenLead");
    expect(await db.counts()).toEqual({ leads: 1, intakeEvents: 2, activities: 2 });
  });
});

describe("a submission with no usable email", () => {
  test("is recorded once, with no lead and no timeline entry", async ({ db }) => {
    const raw = { email: "not an email", full_name: "No Email" };
    const submission = submissionExample({
      externalId: "bad-1",
      email: null,
      name: "No Email",
      raw,
    });

    const first = await db.store.intake(submission);
    const again = await db.store.intake(submission);

    expect(first.outcome).toEqual({ kind: "rejectedNoEmail" });
    expect(again).toEqual({ ...first, replayed: true });
    expect(await ledger(db)).toMatchObject([
      { external_id: "bad-1", email: null, outcome: "rejectedNoEmail", lead_id: null, raw },
    ]);
    expect(await db.counts()).toEqual({ leads: 0, intakeEvents: 1, activities: 0 });
  });
});

describe("a person who is already a lead", () => {
  test("is attached to their open lead, which does not change", async ({ db }) => {
    const { leadId, lifecycle } = await seedHeldLead(db, "ana@example.com", (assignee) => ({
      status: "working",
      assignee,
      stage: { kind: "noAnswer", count: 2 },
    }));

    const result = await db.store.intake(submissionExample({ name: "A different name" }));

    expect(result.outcome).toEqual({ kind: "attachedToOpenLead", leadId });
    const [lead] = await db.store.listLeads(await ownerOf(db), { limit: 10 });
    expect(lead).toMatchObject({ id: leadId, name: null, lifecycle, origin: null });
    expect(await db.counts()).toEqual({ leads: 1, intakeEvents: 1, activities: 1 });
  });

  test("has a lost lead reopened into the pool, with the reason on the timeline", async ({
    db,
  }) => {
    const { leadId, assignee } = await seedHeldLead(db, "ana@example.com", (owner) => ({
      status: "lost",
      assignee: owner,
      reason: "badTiming",
    }));

    const result = await db.store.intake(submissionExample({ source: "metaLeadAds" }));

    expect(result.outcome).toEqual({ kind: "leadReopened", leadId });
    const [lead] = await db.store.listLeads(await ownerOf(db), { limit: 10 });
    expect(lead?.lifecycle).toEqual({
      state: { status: "new" },
      firstAssignedAt: ASSIGNED,
      previousOwnerId: assignee.ownerId,
    });
    expect(await timeline(db)).toEqual([
      {
        kind: "intake",
        lead_id: leadId,
        account_id: null,
        intake_event_id: result.eventId,
        detail: null,
      },
      {
        kind: "statusChange",
        lead_id: leadId,
        account_id: null,
        intake_event_id: null,
        detail: { from: "lost", to: "new", reason: { kind: "inbound", source: "metaLeadAds" } },
      },
    ]);
  });

  test("stays closed when they asked not to be contacted", async ({ db }) => {
    const { leadId, lifecycle } = await seedHeldLead(db, "ana@example.com", (assignee) => ({
      status: "dead",
      assignee,
      reason: "doNotContact",
    }));

    const result = await db.store.intake(submissionExample());

    expect(result.outcome).toEqual({ kind: "suppressedDeadLead", leadId });
    const [lead] = await db.store.listLeads(await ownerOf(db), { limit: 10 });
    expect(lead?.lifecycle).toEqual(lifecycle);
    expect(await db.counts()).toEqual({ leads: 1, intakeEvents: 1, activities: 1 });
  });

  test("is linked to their account once the lead is won", async ({ db }) => {
    const accountId = await db.seedAccount();
    const { leadId, lifecycle } = await seedHeldLead(db, "ana@example.com", (assignee) => ({
      status: "won",
      assignee,
      accountId,
    }));

    const result = await db.store.intake(submissionExample());

    expect(result.outcome).toEqual({ kind: "linkedToAccount", accountId });
    const [lead] = await db.store.listLeads(await ownerOf(db), { limit: 10 });
    expect(lead).toMatchObject({ id: leadId, lifecycle });
    expect(await timeline(db)).toEqual([
      {
        kind: "intake",
        lead_id: null,
        account_id: accountId,
        intake_event_id: result.eventId,
        detail: null,
      },
    ]);
  });
});

describe("hostile input", () => {
  test("stores a record whose text holds a NUL character", async ({ db }) => {
    const raw = { note: "before\u0000after", nested: ["\u0000"] };
    const result = await db.store.intake(submissionExample({ raw }));

    expect(result.outcome.kind).toBe("leadCreated");
    expect(await db.rows("SELECT raw FROM intake_events")).toEqual([{ raw }]);
  });
});

for (const reason of ["duplicate", "wrongNumber", "doNotContact"] as const) {
  for (const source of ["webForm", "metaLeadAds", "csv", "manual"] as const) {
    test(`never reopens a dead ${reason} lead through ${source}`, async ({ db }) => {
      const { leadId, assignee } = await seedHeldLead(db, "dead@example.com", (held) => ({
        status: "dead",
        assignee: held,
        reason,
      }));
      await db.store.intake(
        submissionExample({
          source,
          externalId: `dead-${reason}-${source}`,
          email: "dead@example.com",
        }),
      );
      expect(
        await db.rows("SELECT status,owner_id,dead_reason FROM leads WHERE id=$1", [leadId]),
      ).toEqual([{ status: "dead", owner_id: assignee.ownerId, dead_reason: reason }]);
      expect(await db.rows("SELECT id FROM audit_log")).toEqual([]);
    });
  }
}
