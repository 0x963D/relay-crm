import type { IntakeResult } from "@relay/domain";
import { intakeFake, intakeResultExample } from "@relay/domain/testing";
import { describe, expect, it } from "vitest";
import { CsvHeaderError, importCsv } from "../src/server/intake/csv.ts";

const NOW = new Date("2026-11-14T10:00:00.000Z");
const now = (): Date => NOW;

function csv(...lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

async function keysOf(text: string): Promise<readonly string[]> {
  const fake = intakeFake();
  await importCsv({ intake: fake.intake, now }, text);
  return fake.received.map((submission) => submission.externalId);
}

describe("importCsv", () => {
  it("sends each row to intake in file order, with the row kept as the original record", async () => {
    const fake = intakeFake();

    await importCsv(
      { intake: fake.intake, now },
      csv(
        "email,name,phone,campaign,ad_set,ad,form,external_id",
        "Ana@Example.com,Ana Silva,+44 20 7946 0958,Spring,Lookalikes,Video 2,contact,row-1",
        "ben@example.com,Ben Okoro,,,,,,row-2",
      ),
    );

    expect(fake.received).toEqual([
      {
        source: "csv",
        externalId: "row-1",
        email: "ana@example.com",
        name: "Ana Silva",
        phone: "+44 20 7946 0958",
        attribution: { campaign: "Spring", adSet: "Lookalikes", ad: "Video 2", form: "contact" },
        submittedAt: null,
        receivedAt: NOW,
        raw: {
          email: "Ana@Example.com",
          name: "Ana Silva",
          phone: "+44 20 7946 0958",
          campaign: "Spring",
          ad_set: "Lookalikes",
          ad: "Video 2",
          form: "contact",
          external_id: "row-1",
        },
      },
      expect.objectContaining({
        externalId: "row-2",
        email: "ben@example.com",
        name: "Ben Okoro",
        phone: null,
        attribution: { campaign: null, adSet: null, ad: null, form: null },
      }),
    ]);
  });

  it("reads headers whatever their case and spacing, and skips a byte-order mark", async () => {
    const fake = intakeFake();

    await importCsv(
      { intake: fake.intake, now },
      `\uFEFF${csv(" Email ,NAME,Ad Set,External-ID", "ana@example.com,Ana Silva,Lookalikes,row-1")}`,
    );

    expect(fake.received).toMatchObject([
      {
        externalId: "row-1",
        email: "ana@example.com",
        name: "Ana Silva",
        attribution: { adSet: "Lookalikes" },
      },
    ]);
  });

  it("reads quoted fields that hold commas and line breaks", async () => {
    const fake = intakeFake();

    await importCsv(
      { intake: fake.intake, now },
      csv("email,name,campaign", 'ana@example.com,"Silva, Ana","Spring', 'sale"'),
    );

    expect(fake.received).toMatchObject([
      { name: "Silva, Ana", attribution: { campaign: "Spring sale" } },
    ]);
  });

  it("sends a row with no usable email to intake, which records the rejection", async () => {
    const fake = intakeFake();

    await importCsv({ intake: fake.intake, now }, csv("email,name", "not an email,Ana Silva"));

    expect(fake.received).toMatchObject([{ email: null, name: "Ana Silva" }]);
  });
});

describe("the key of a row with no external_id", () => {
  it("is a SHA-256 of the row's normalized fields, in a recipe that must not change", async () => {
    expect(await keysOf(csv("email,name,campaign", "ana@example.com,Ana Silva,spring"))).toEqual([
      "sha256:7f3a14556016277aaa310a26c916f31e7d085d2581cb42be29cc6a5de800a8f8",
    ]);
  });

  it("is the same wherever the row sits and however its email is typed", async () => {
    const alone = await keysOf(csv("email,name,campaign", "ana@example.com,Ana Silva,spring"));
    const moved = await keysOf(
      csv(
        "campaign,name,email",
        "autumn,Ben Okoro,ben@example.com",
        "spring,  Ana   Silva , ANA@Example.com",
      ),
    );

    expect(moved[1]).toBe(alone[0]);
  });

  it("changes when the row's content changes", async () => {
    const before = await keysOf(csv("email,name", "ana@example.com,Ana Silva"));
    const after = await keysOf(csv("email,name", "ana@example.com,Ana Silva-Costa"));

    expect(after[0]).not.toBe(before[0]);
  });
});

describe("the import report", () => {
  it("counts new outcomes, replays and rows", async () => {
    const results: readonly IntakeResult[] = [
      intakeResultExample(),
      { ...intakeResultExample(), replayed: true },
      { ...intakeResultExample(), outcome: { kind: "rejectedNoEmail" } },
      intakeResultExample(),
    ];
    let row = 0;
    const fake = intakeFake(() => results[row++] ?? intakeResultExample());

    const report = await importCsv(
      { intake: fake.intake, now },
      csv("email", "a@example.com", "b@example.com", "nobody", "d@example.com"),
    );

    expect(report).toEqual({
      rows: 4,
      byOutcome: {
        leadCreated: 2,
        attachedToOpenLead: 0,
        leadReopened: 0,
        linkedToAccount: 0,
        suppressedDoNotContact: 0,
        rejectedNoEmail: 1,
      },
      replayed: 1,
      failures: [],
    });
  });

  it("reports a row that fails with its line and keeps going", async () => {
    const fake = intakeFake((submission) => {
      if (submission.externalId === "row-2") throw new Error("the database is down");
      return intakeResultExample();
    });

    const report = await importCsv(
      { intake: fake.intake, now },
      csv("email,external_id", "a@example.com,row-1", "b@example.com,row-2", "c@example.com,row-3"),
    );

    expect(report.failures).toEqual([{ line: 3, message: "the database is down" }]);
    expect(report.byOutcome.leadCreated).toBe(2);
    expect(fake.received.map((submission) => submission.externalId)).toEqual([
      "row-1",
      "row-2",
      "row-3",
    ]);
  });

  it("reports an external_id that cannot be a key without calling intake for it", async () => {
    const fake = intakeFake();

    const report = await importCsv(
      { intake: fake.intake, now },
      csv("email,external_id", `a@example.com,${"x".repeat(201)}`),
    );

    expect(report.failures).toEqual([
      { line: 2, message: "The external_id must be 1 to 200 characters." },
    ]);
    expect(fake.received).toEqual([]);
  });
});

describe("a file that cannot be imported", () => {
  it.each([
    ["has no email column", csv("name,phone", "Ana Silva,123")],
    ["is empty", ""],
  ])("is refused before intake is called when it %s", async (_label, text) => {
    const fake = intakeFake();

    await expect(importCsv({ intake: fake.intake, now }, text)).rejects.toThrow(CsvHeaderError);
    expect(fake.received).toEqual([]);
  });
});
