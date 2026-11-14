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
