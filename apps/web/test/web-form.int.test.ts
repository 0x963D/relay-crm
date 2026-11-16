import { test, type TestDatabase } from "@relay/store/testing";
import { describe, expect } from "vitest";
import { limitKey } from "../src/server/rate-limit.ts";
import { connections } from "../src/server/client-address.ts";
import { createWebFormEndpoint } from "../src/server/intake/web-form.ts";

const FORM_URL = "https://crm.example/api/intake/form";

test("an intake database error logs its class, code and request ID without the submitted row", async ({
  db,
}) => {
  await db.ownerRows(`CREATE FUNCTION fail_intake() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'cannot insert %', NEW.email; END $$;
    CREATE TRIGGER fail_intake BEFORE INSERT ON leads FOR EACH ROW EXECUTE FUNCTION fail_intake()`);
  const logged: Record<string, unknown>[] = [];
  const form = createWebFormEndpoint({
    intake: db.store.intake,
    limits: db.store,
    trustedProxyCount: 0,
    now: () => new Date(),
    log: (event, detail) => {
      logged.push({ event, ...detail });
    },
  });
  const email = "private-submission@example.com";
  const response = await connections.run("127.0.0.1", () => form.POST(submit({ email })));
  expect(response.status).toBe(503);
  const body: unknown = await response.json();
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({
    event: "webForm.intake.failed",
    error: { class: "PrismaClientKnownRequestError" },
  });
  expect(logged[0]?.requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(JSON.stringify(logged[0]?.error)).toMatch(/"code":"P[0-9]{4}"/);
  expect(body).toMatchObject({ requestId: logged[0]?.requestId });
  expect(JSON.stringify(logged)).not.toContain(email);
  expect(JSON.stringify(logged)).not.toContain("message");
  expect(JSON.stringify(body)).not.toContain(email);
});

function formOver(db: TestDatabase) {
  const form = createWebFormEndpoint({
    intake: db.store.intake,
    limits: db.store,
    trustedProxyCount: 0,
    now: () => new Date("2026-11-14T09:30:00.000Z"),
    log: () => undefined,
  });
  return {
    POST: (request: Request) =>
      connections.run(connections.getStore() ?? "127.0.0.1", () => form.POST(request)),
  };
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

test("limits anonymous cross-origin submissions across endpoint instances", async ({ db }) => {
  for (let i = 0; i < 10; i += 1) {
    const request = submit({ email: `visitor-${String(i)}@example.com` });
    request.headers.set("origin", "https://other.example");
    expect((await formOver(db).POST(request)).status).toBe(202);
  }
  const refused = await formOver(db).POST(submit({ email: "one-more@example.com" }));
  expect(refused.status).toBe(429);
  expect(refused.headers.get("retry-after")).toBe("60");
  expect((await db.counts()).leads).toBe(10);
});

test("the shared global budget limits another client without recording an intake", async ({
  db,
}) => {
  await db.rows(
    "INSERT INTO auth_request_limits(key,count,started_at) VALUES ('form:global',1000,now())",
  );
  const response = await connections.run("192.0.2.2", () =>
    formOver(db).POST(submit({ email: "global@example.com" })),
  );
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("60");
  expect((await db.counts()).leads).toBe(0);
});

test("an exhausted client cannot spend the global form budget", async ({ db }) => {
  await db.rows("INSERT INTO auth_request_limits(key,count,started_at) VALUES ($1,10,now())", [
    limitKey("form:client", "192.0.2.1"),
  ]);
  const response = await connections.run("192.0.2.1", () =>
    formOver(db).POST(submit({ email: "limited@example.com" })),
  );
  expect(response.status).toBe(429);
  expect(await db.rows("SELECT key FROM auth_request_limits WHERE key='form:global'")).toEqual([]);
});
