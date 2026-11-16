import { randomUUID } from "node:crypto";
import { parseEmail } from "@relay/domain";
import { submissionExample } from "@relay/domain/testing";
import { describe, expect } from "vitest";
import { test, type TestDatabase } from "../src/testing/index.ts";

const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";
const AT = "2026-03-02T09:00:00.000Z";

type Row = Readonly<Record<string, unknown>>;

function insert(db: TestDatabase, table: string, row: Row): Promise<unknown> {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${String(index + 1)}`);
  return db.rows(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
    Object.values(row),
  );
}

interface People {
  readonly owner: string;
  readonly team: string;
  readonly account: string;
  readonly lead: string;
}

function lead(columns: Row): Row {
  return {
    id: randomUUID(),
    email: "ana@example.com",
    status: "new",
    created_at: AT,
    ...columns,
  };
}

const REJECTED: readonly (readonly [
  what: string,
  constraint: string,
  table: string,
  row: (people: People) => Row,
])[] = [
  [
    "a pooled lead with an owner",
    "leads_state_shape",
    "leads",
    (p) => lead({ owner_id: p.owner, team_id: p.team, first_assigned_at: AT }),
  ],
  [
    "an assigned lead with no owner",
    "leads_state_shape",
    "leads",
    () => lead({ status: "assigned" }),
  ],
  [
    "an owner with no team",
    "leads_state_shape",
    "leads",
    (p) => lead({ status: "assigned", owner_id: p.owner, first_assigned_at: AT }),
  ],
  [
    "a working lead with no stage",
    "leads_state_shape",
    "leads",
    (p) => lead({ status: "working", owner_id: p.owner, team_id: p.team, first_assigned_at: AT }),
  ],
  [
    "a won lead with no account",
    "leads_state_shape",
    "leads",
    (p) => lead({ status: "won", owner_id: p.owner, team_id: p.team, first_assigned_at: AT }),
  ],
  [
    "an account on a lead that is not won",
    "leads_state_shape",
    "leads",
    (p) =>
      lead({
        status: "lost",
        owner_id: p.owner,
        team_id: p.team,
        first_assigned_at: AT,
        lost_note: "other",
        account_id: p.account,
      }),
  ],
  [
    "a lost lead with no reason",
    "leads_state_shape",
    "leads",
    (p) => lead({ status: "lost", owner_id: p.owner, team_id: p.team, first_assigned_at: AT }),
  ],
  [
    "a dead lead that also has a lost reason",
    "leads_state_shape",
    "leads",
    () => lead({ status: "dead", dead_reason: "duplicate", lost_note: "other" }),
  ],
  [
    "a call-back stage with no time",
    "leads_stage_shape",
    "leads",
    (p) =>
      lead({
        status: "working",
        stage: "callBack",
        owner_id: p.owner,
        team_id: p.team,
        first_assigned_at: AT,
      }),
  ],
  [
    "a no-answer stage that counts zero calls",
    "leads_stage_shape",
    "leads",
    (p) =>
      lead({
        status: "working",
        stage: "noAnswer",
        no_answer_count: 0,
        owner_id: p.owner,
        team_id: p.team,
        first_assigned_at: AT,
      }),
  ],
  [
    "a contacted stage that carries a call count",
    "leads_stage_shape",
    "leads",
    (p) =>
      lead({
        status: "working",
        stage: "contacted",
        no_answer_count: 1,
        owner_id: p.owner,
        team_id: p.team,
        first_assigned_at: AT,
      }),
  ],
  [
    "an owned lead that was never assigned",
    "leads_owned_was_assigned",
    "leads",
    (p) => lead({ status: "assigned", owner_id: p.owner, team_id: p.team }),
  ],
  [
    "an email with an uppercase letter",
    "leads_email_canonical",
    "leads",
    () => lead({ email: "Ana@example.com" }),
  ],
  [
    "an email with a space",
    "leads_email_canonical",
    "leads",
    () => lead({ email: "ana @example.com" }),
  ],
  [
    "an email with a non-ASCII local part",
    "leads_email_canonical",
    "leads",
    () => lead({ email: "josé@example.com" }),
  ],
  [
    "an email whose domain is not punycode",
    "leads_email_canonical",
    "leads",
    () => lead({ email: "ana@bücher.example" }),
  ],
  [
    "an email with no at sign",
    "leads_email_canonical",
    "leads",
    () => lead({ email: "ana.example.com" }),
  ],
  [
    "an email at an IPv4 address",
    "leads_email_canonical",
    "leads",
    () => lead({ email: "ana@127.0.0.1" }),
  ],
  [
    "an email with a local part longer than 64 characters",
    "leads_email_canonical",
    "leads",
    () => lead({ email: `${"a".repeat(65)}@example.com` }),
  ],
  [
    "a created-lead event that points at no lead",
    "intake_events_outcome_subject",
    "intake_events",
    () => ({
      id: randomUUID(),
      source: "csv",
      external_id: "x-1",
      received_at: AT,
      raw: "{}",
      outcome: "leadCreated",
    }),
  ],
  [
    "a rejected event that points at a lead",
    "intake_events_outcome_subject",
    "intake_events",
    (p) => ({
      id: randomUUID(),
      source: "csv",
      external_id: "x-2",
      received_at: AT,
      raw: "{}",
      outcome: "rejectedNoEmail",
      lead_id: p.lead,
    }),
  ],
  [
    "an account-link event that points at a lead",
    "intake_events_outcome_subject",
    "intake_events",
    (p) => ({
      id: randomUUID(),
      source: "csv",
      external_id: "x-3",
      received_at: AT,
      raw: "{}",
      outcome: "linkedToAccount",
      lead_id: p.lead,
    }),
  ],
  [
    "an activity with no subject",
    "activities_one_subject",
    "activities",
    () => ({ id: randomUUID(), kind: "statusChange", at: AT }),
  ],
  [
    "an activity with two subjects",
    "activities_one_subject",
    "activities",
    (p) => ({
      id: randomUUID(),
      kind: "statusChange",
      at: AT,
      lead_id: p.lead,
      account_id: p.account,
    }),
  ],
  [
    "an intake activity with no ledger row",
    "activities_intake_ref",
    "activities",
    (p) => ({ id: randomUUID(), kind: "intake", at: AT, lead_id: p.lead }),
  ],
];

describe("what the database refuses by itself", () => {
  test.for(REJECTED)("%s", async ([, constraint, table, row], { db }) => {
    const people: People = {
      owner: await db.seedUser("agent"),
      team: await db.seedTeam("sales"),
      account: await db.seedAccount(),
      lead: await db.seedLead({
        email: "existing@example.com",
        lifecycle: { state: { status: "new" }, firstAssignedAt: null, previousOwnerId: null },
      }),
    };

    await expect(insert(db, table, row(people))).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint,
    });
  });

  test("a status the state constraint has not heard of fails closed", async ({ db }) => {
    await db.ownerRows("ALTER TYPE lead_status ADD VALUE 'archived'");

    await expect(insert(db, "leads", lead({ status: "archived" }))).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: "leads_state_shape",
    });
  });
});

describe("the canonical email constraint", () => {
  const LONGEST = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`;

  test("admits every address parseEmail produces", async ({ db }) => {
    const inputs = [
      "Ana.Silva@Example.COM",
      "a!#$%&'*+-/=?^_`{|}~z@example.com",
      "ana+crm@mail-2.example9.co.uk",
      "ana@BÜCHER.example",
      "ana@例え.テスト",
      LONGEST,
    ];
    expect(LONGEST).toHaveLength(254);

    for (const input of inputs) {
      const parsed = parseEmail(input);
      if (!parsed.ok) throw new Error(`Expected ${input} to parse`);
      await insert(db, "leads", lead({ email: parsed.value }));
    }

    expect(await db.counts()).toMatchObject({ leads: inputs.length });
  });
});

describe("append-only logs", () => {
  test.for([
    ["an update of the ledger", "UPDATE intake_events SET name = 'changed'"],
    ["a delete from the ledger", "DELETE FROM intake_events"],
    ["an update of the timeline", "UPDATE activities SET at = now()"],
    ["a delete from the timeline", "DELETE FROM activities"],
  ] as const)("refuse %s", async ([, statement], { db }) => {
    await db.store.intake(submissionExample());

    await expect(db.rows(statement)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    expect(await db.counts()).toEqual({ leads: 1, intakeEvents: 1, activities: 1 });
  });
});
