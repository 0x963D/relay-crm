import { test, type TestDatabase } from "@relay/store/testing";
import { describe, expect } from "vitest";
import { importCsv } from "../src/server/intake/csv.ts";

const FILE = [
  "email,name,campaign",
  "ana@example.com,Ana Silva,spring",
  "ben@example.com,Ben Okoro,spring",
  "not an email,Nobody,spring",
  "",
].join("\n");

function run(db: TestDatabase, text: string) {
  return importCsv(
    { intake: db.store.intake, now: () => new Date("2026-11-14T10:00:00.000Z") },
    text,
  );
}

describe("a CSV import over a real database", () => {
  test("records every row, and a second import of the same file changes nothing", async ({
    db,
  }) => {
    const first = await run(db, FILE);
    const second = await run(db, FILE);

    expect(first).toMatchObject({
      rows: 3,
      byOutcome: { leadCreated: 2, rejectedNoEmail: 1 },
      replayed: 0,
      failures: [],
    });
    expect(second).toMatchObject({
      rows: 3,
      byOutcome: { leadCreated: 0, rejectedNoEmail: 0 },
      replayed: 3,
      failures: [],
    });
    expect(await db.counts()).toEqual({ leads: 2, intakeEvents: 3, activities: 2 });
  });

  test("a corrected row is the only one imported again", async ({ db }) => {
    await run(db, FILE);

    const corrected = await run(db, FILE.replace("not an email", "cara@example.com"));

    expect(corrected).toMatchObject({ byOutcome: { leadCreated: 1 }, replayed: 2 });
    expect(await db.counts()).toEqual({ leads: 3, intakeEvents: 4, activities: 3 });
  });
});

const POOLED = { state: { status: "new" }, firstAssignedAt: null, previousOwnerId: null } as const;

describe("a row whose address matches a lead's only through a lookalike letter", () => {
  test("is recorded with no email and never attaches to that lead", async ({ db }) => {
    const leadId = await db.seedLead({ email: "kim@kelvin.example", lifecycle: POOLED });
    const typed = ["\u212Aim@kelvin.example", "kim@\u212Aelvin.example"];

    const report = await run(db, ["email", ...typed, ""].join("\n"));

    expect(report.byOutcome).toMatchObject({ rejectedNoEmail: 2, attachedToOpenLead: 0 });
    expect(await db.rows("SELECT email, outcome, lead_id FROM intake_events")).toEqual([
      { email: null, outcome: "rejectedNoEmail", lead_id: null },
      { email: null, outcome: "rejectedNoEmail", lead_id: null },
    ]);
    expect(await db.rows("SELECT id, email FROM leads")).toEqual([
      { id: leadId, email: "kim@kelvin.example" },
    ]);
    const kept = await db.rows("SELECT raw->>'email' AS email FROM intake_events");
    expect(kept.map((row) => row.email).sort()).toEqual([...typed].sort());
  });
});

describe("a row whose address differs from a lead's only in ASCII case", () => {
  test("attaches to that lead", async ({ db }) => {
    const leadId = await db.seedLead({ email: "kim@kelvin.example", lifecycle: POOLED });

    const report = await run(db, ["email", "KIM@Kelvin.Example", ""].join("\n"));

    expect(report.byOutcome).toMatchObject({ attachedToOpenLead: 1 });
    expect(await db.rows("SELECT email, lead_id FROM intake_events")).toEqual([
      { email: "kim@kelvin.example", lead_id: leadId },
    ]);
  });
});
