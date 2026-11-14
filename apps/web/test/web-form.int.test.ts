import { test, type TestDatabase } from "@relay/store/testing";
import { describe, expect } from "vitest";
import { createWebFormEndpoint } from "../src/server/intake/web-form.ts";

const FORM_URL = "https://crm.example/api/intake/form";

function formOver(db: TestDatabase) {
  return createWebFormEndpoint({
    intake: db.store.intake,
    now: () => new Date("2026-11-14T09:30:00.000Z"),
    log: () => undefined,
  });
}

function submit(fields: Readonly<Record<string, string>>): Request {
  return new Request(FORM_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("the web form over a real database", () => {
  test("a double submit with no submission ID records two events and one lead", async ({ db }) => {
    const form = formOver(db);
    const fields = { email: "ana@example.com", name: "Ana Silva", campaign: "spring" };

    const responses = [await form.POST(submit(fields)), await form.POST(submit(fields))];

    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect(await db.rows("SELECT outcome FROM intake_events ORDER BY id")).toEqual([
      { outcome: "leadCreated" },
      { outcome: "attachedToOpenLead" },
    ]);
    expect(await db.counts()).toEqual({ leads: 1, intakeEvents: 2, activities: 2 });
  });

  test("a double submit with one submission ID records one event", async ({ db }) => {
    const form = formOver(db);
    const fields = {
      email: "ana@example.com",
      submissionId: "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b",
    };

    const responses = [await form.POST(submit(fields)), await form.POST(submit(fields))];

    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect(await db.counts()).toEqual({ leads: 1, intakeEvents: 1, activities: 1 });
  });

  test("an invalid email writes nothing", async ({ db }) => {
    const response = await formOver(db).POST(submit({ email: "not an address" }));

    expect(response.status).toBe(422);
    expect(await db.counts()).toEqual({ leads: 0, intakeEvents: 0, activities: 0 });
  });
});
