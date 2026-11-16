import { expect, describe } from "vitest";
import { test } from "@relay/store/testing";
import { connections } from "../src/server/client-address.ts";
import { appRouter } from "../src/server/rpc.ts";
import { createAuthentication } from "../src/server/auth.ts";
import type { AuthEnv } from "../src/server/env.ts";

const origin = "http://localhost:3401";
const config: AuthEnv = {
  trustedProxyCount: 0,
  globalLimit: 10_000,
  secret: "fake-test-secret-that-is-at-least-thirty-two-characters",
  baseUrl: origin,
  delivery: { kind: "developmentConsole" },
};

function setup(store: Parameters<typeof createAuthentication>[0]) {
  const sent: { email: string; code: string }[] = [];
  const tasks: (() => Promise<void>)[] = [];
  const auth = createAuthentication(
    store,
    config,
    (message) => {
      sent.push(message);
      return Promise.resolve();
    },
    (task) => {
      tasks.push(task);
    },
  );
  async function post(path: string, body: unknown) {
    const started = performance.now();
    const response = await auth.handle(
      new Request(`${origin}/api/auth${path}`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const elapsed = performance.now() - started;
    for (const task of tasks.splice(0)) await task();
    return { response, elapsed };
  }
  return { auth, sent, post };
}
async function cookieOf(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("relay.session_token="));
  if (!cookie) throw new Error("Sign-in returned no session cookie");
  return cookie.split(";")[0] ?? "";
}

describe("email sign-in", () => {
  test("known and unknown addresses have the same response and bounded timing class, without unknown mail or sessions", async ({
    db,
  }) => {
    await db.seedUser("agent");
    const { post, sent, auth } = setup(db.store);
    const known = await post("/email-otp/send-verification-otp", {
      email: "user-1@team.example",
      type: "sign-in",
    });
    const unknown = await post("/email-otp/send-verification-otp", {
      email: "unknown@example.com",
      type: "sign-in",
    });
    expect(known.response.status).toBe(200);
    expect(unknown.response.status).toBe(known.response.status);
    expect(await unknown.response.json()).toEqual(await known.response.json());
    expect(known.elapsed).toBeGreaterThanOrEqual(290);
    expect(unknown.elapsed).toBeGreaterThanOrEqual(290);
    expect(Math.abs(known.elapsed - unknown.elapsed)).toBeLessThan(500);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.email).toBe("user-1@team.example");
    const denied = await post("/sign-in/email-otp", {
      email: "unknown@example.com",
      otp: "123456",
    });
    expect(denied.response.status).toBe(400);
    expect(await auth.principal(new Headers())).toBeNull();
    expect(await db.rows("SELECT email FROM users")).toEqual([{ email: "user-1@team.example" }]);
    expect(await db.rows("SELECT user_id FROM auth_sessions")).toEqual([]);
    expect(
      await db.rows("SELECT identifier FROM auth_verifications WHERE identifier LIKE '%unknown%'"),
    ).toEqual([]);
  });

  test("a real emailed code signs in once and a session loads the current role and selected membership", async ({
    db,
  }) => {
    const userId = await db.seedUser("teamLead");
    const teamId = await db.seedTeam("sales");
    const foreign = await db.seedTeam("sales");
    await db.rows("INSERT INTO memberships(user_id,team_id,is_lead) VALUES ($1,$2,true)", [
      userId,
      teamId,
    ]);
    const { post, sent, auth } = setup(db.store);
    await post("/email-otp/send-verification-otp", {
      email: "User-1@Team.Example",
      type: "sign-in",
    });
    const code = sent[0]?.code;
    expect(code).toMatch(/^\d{6}$/);
    const signed = await post("/sign-in/email-otp", { email: "user-1@team.example", otp: code });
    const cookie = await cookieOf(signed.response);
    expect(cookie).toContain("relay.session_token=");
    expect(signed.response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(signed.response.headers.get("set-cookie")).toContain("SameSite=Lax");
    const headers = new Headers({ cookie });
    expect(await db.rows("SELECT current_team_id FROM auth_sessions")).toEqual([
      { current_team_id: teamId },
    ]);
    const principal = await auth.principal(headers);
    expect(principal?.actor).toMatchObject({
      userId,
      role: "teamLead",
      team: { id: teamId, kind: "sales", isLead: true },
    });
    expect(await db.rows("SELECT current_team_id FROM auth_sessions")).toEqual([
      { current_team_id: teamId },
    ]);
    if (principal?.kind !== "session") throw new Error("No authenticated principal");
    await expect(db.store.selectTeam(principal.session.id, foreign)).rejects.toMatchObject({
      code: "accessDenied",
    });
    await db.store.selectTeam(principal.session.id, teamId);
    expect((await auth.principal(headers))?.actor.team).toEqual({
      id: teamId,
      kind: "sales",
      isLead: true,
    });
    await db.rows("UPDATE users SET role='agent' WHERE id=$1", [userId]);
    expect((await auth.principal(headers))?.actor.role).toBe("agent");
    await db.rows("DELETE FROM memberships WHERE user_id=$1", [userId]);
    expect((await auth.principal(headers))?.actor.team).toBeNull();
    const replay = await post("/sign-in/email-otp", { email: "user-1@team.example", otp: code });
    expect(replay.response.status).toBe(400);
    expect(await db.rows("SELECT count(*)::int AS count FROM auth_sessions")).toEqual([
      { count: 1 },
    ]);
    await db.rows("UPDATE auth_sessions SET expires_at=now()-interval '1 second'");
    expect(await auth.principal(headers)).toBeNull();
  });

  test("expired codes fail and wrong guesses exhaust a code", async ({ db }) => {
    await db.seedUser("agent");
    const { post, sent } = setup(db.store);
    await post("/email-otp/send-verification-otp", {
      email: "user-1@team.example",
      type: "sign-in",
    });
    await db.rows("UPDATE auth_verifications SET expires_at=now()-interval '1 second'");
    expect(
      (await post("/sign-in/email-otp", { email: "user-1@team.example", otp: sent[0]?.code }))
        .response.status,
    ).toBe(400);
    await post("/email-otp/send-verification-otp", {
      email: "user-1@team.example",
      type: "sign-in",
    });
    const code = sent[1]?.code;
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 3; attempt += 1)
      expect(
        (await post("/sign-in/email-otp", { email: "user-1@team.example", otp: wrong })).response
          .status,
      ).toBe(400);
    expect(
      (await post("/sign-in/email-otp", { email: "user-1@team.example", otp: code })).response
        .status,
    ).not.toBe(200);
    expect(await db.rows("SELECT user_id FROM auth_sessions")).toEqual([]);
  });

  test("requests are rate limited persistently for known and unknown addresses", async ({ db }) => {
    await db.seedUser("agent");
    for (const email of ["user-1@team.example", "unknown@example.com"]) {
      const { post } = setup(db.store);
      for (let request = 0; request < 3; request += 1)
        expect(
          (await post("/email-otp/send-verification-otp", { email, type: "sign-in" })).response
            .status,
        ).toBe(200);
      const another = setup(db.store);
      const limited = await another.post("/email-otp/send-verification-otp", {
        email,
        type: "sign-in",
      });
      expect(limited.response.status).toBe(429);
      expect(limited.response.headers.get("retry-after")).toBe("60");
    }
  });

  test("sign-up and unneeded auth endpoints are closed and cross-origin requests are refused", async ({
    db,
  }) => {
    const { post, auth } = setup(db.store);
    for (const path of [
      "/sign-up/email",
      "/email-otp/check-verification-otp",
      "/email-otp/verify-email",
      "/update-user",
    ])
      expect((await post(path, {})).response.status).toBe(404);
    expect(
      (
        await auth.handle(
          new Request(`${origin}/api/auth/email-otp/send-verification-otp`, {
            method: "POST",
            headers: { origin: "https://other.example", "content-type": "application/json" },
            body: JSON.stringify({ email: "unknown@example.com", type: "sign-in" }),
          }),
        )
      ).status,
    ).toBe(403);
    expect(await db.rows("SELECT id FROM users")).toEqual([]);
  });
});

test("multiple memberships require a team choice and the session API returns the choices", async ({
  db,
}) => {
  const userId = await db.seedUser("teamLead");
  const teams = [await db.seedTeam("sales"), await db.seedTeam("sales")];
  for (const teamId of teams)
    await db.rows("INSERT INTO memberships(user_id,team_id,is_lead) VALUES ($1,$2,true)", [
      userId,
      teamId,
    ]);
  const { post, sent, auth } = setup(db.store);
  await post("/email-otp/send-verification-otp", { email: "user-1@team.example", type: "sign-in" });
  const signed = await post("/sign-in/email-otp", {
    email: "user-1@team.example",
    otp: sent[0]?.code,
  });
  const headers = new Headers({ cookie: await cookieOf(signed.response) });
  const principal = await auth.principal(headers);
  if (principal?.kind !== "session") throw new Error("No session");
  await expect(db.store.listLeads(principal.actor, { limit: 100 })).rejects.toMatchObject({
    code: "teamSelectionRequired",
    message: "Choose a current team before using team-scoped operations.",
  });
  const caller = appRouter.createCaller({ store: db.store, principal });
  const current = await caller.session.current();
  expect(current.actor.teams?.map((team) => team.id).sort()).toEqual([...teams].sort());
  await caller.session.selectTeam({ teamId: teams[0] ?? null });
  const selected = await auth.principal(headers);
  expect(selected?.actor.team?.id).toBe(teams[0]);
  if (!selected) throw new Error("No selected session");
  expect(await db.store.listLeads(selected.actor, { limit: 100 })).toEqual([]);
});

test("a completed request replays through a valid session after role revocation but never after expiry", async ({
  db,
}) => {
  const userId = await db.seedUser("manager");
  const ownerId = await db.seedUser("agent");
  const teamId = await db.seedTeam("sales");
  await db.rows("INSERT INTO memberships(user_id,team_id) VALUES ($1,$2)", [ownerId, teamId]);
  const leadId = await db.seedLead({
    email: "replay@example.com",
    lifecycle: { state: { status: "new" }, firstAssignedAt: null, previousOwnerId: null },
  });
  const { post, sent, auth } = setup(db.store);
  await post("/email-otp/send-verification-otp", { email: "user-1@team.example", type: "sign-in" });
  const signed = await post("/sign-in/email-otp", {
    email: "user-1@team.example",
    otp: sent[0]?.code,
  });
  const headers = new Headers({ cookie: await cookieOf(signed.response) });
  const caller = appRouter.createCaller({
    store: db.store,
    principal: await auth.principal(headers),
  });
  const preview = await caller.distribution.preview({
    leadIds: [leadId],
    agents: [{ ownerId, teamId }],
    excludePreviousOwner: false,
  });
  const input = { previewId: preview.id, fingerprint: preview.fingerprint, key: "session-replay" };
  const first = await caller.distribution.submit(input);
  await db.rows("UPDATE users SET role='accountant' WHERE id=$1", [userId]);
  const current = appRouter.createCaller({
    store: db.store,
    principal: await auth.principal(headers),
  });
  expect(await current.distribution.submit(input)).toEqual(first);
  await expect(
    current.distribution.submit({ ...input, fingerprint: "a".repeat(64) }),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    message: "The key was already used for a different request.",
  });
  await db.rows("UPDATE auth_sessions SET expires_at=now()-interval '1 second'");
  const expired = appRouter.createCaller({
    store: db.store,
    principal: await auth.principal(headers),
  });
  await expect(expired.distribution.submit(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("one client cannot exhaust sign-in for a second client", async ({ db }) => {
  await db.seedUser("agent");
  const first = setup(db.store);
  for (let i = 0; i < 20; i += 1) {
    const result = await connections.run("192.0.2.1", () =>
      first.post("/email-otp/send-verification-otp", {
        email: `unknown-${String(i)}@example.com`,
        type: "sign-in",
      }),
    );
    expect(result.response.status).toBe(200);
  }
  const refused = [];
  for (const email of ["user-1@team.example", "unknown@example.com"]) {
    const result = await connections.run("192.0.2.1", () =>
      setup(db.store).post("/email-otp/send-verification-otp", { email, type: "sign-in" }),
    );
    expect(result.response.status).toBe(429);
    expect(result.response.headers.get("retry-after")).toBe("60");
    refused.push(await result.response.json());
  }
  expect(refused[0]).toEqual(refused[1]);
  const second = setup(db.store);
  const requested = await connections.run("192.0.2.2", () =>
    second.post("/email-otp/send-verification-otp", {
      email: "user-1@team.example",
      type: "sign-in",
    }),
  );
  expect(requested.response.status).toBe(200);
  const signed = await connections.run("192.0.2.2", () =>
    second.post("/sign-in/email-otp", { email: "user-1@team.example", otp: second.sent[0]?.code }),
  );
  expect(await cookieOf(signed.response)).toContain("relay.session_token=");
  expect(await db.rows("SELECT count FROM auth_request_limits WHERE key='auth:global'")).toEqual([
    { count: 22 },
  ]);
});

test("the default global circuit breaker permits more than the former shared sign-in budget", async ({
  db,
}) => {
  await db.rows(
    "INSERT INTO auth_request_limits(key,count,started_at) VALUES ('auth:global',100,now())",
  );
  const result = await setup(db.store).post("/email-otp/send-verification-otp", {
    email: "unknown@example.com",
    type: "sign-in",
  });
  expect(result.response.status).toBe(200);
});

test("known and unknown emails have identical refusals at the global circuit breaker", async ({
  db,
}) => {
  await db.seedUser("agent");
  await db.rows(
    "INSERT INTO auth_request_limits(key,count,started_at) VALUES ('auth:global',10000,now())",
  );
  const { post } = setup(db.store);
  const responses = [];
  for (const email of ["user-1@team.example", "unknown@example.com"]) {
    const { response } = await post("/email-otp/send-verification-otp", { email, type: "sign-in" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    responses.push(await response.json());
  }
  expect(responses[0]).toEqual(responses[1]);
});
