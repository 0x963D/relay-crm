import { expect, vi } from "vitest";
import { test } from "@relay/store/testing";
import { resetDemo, seedDemo } from "@relay/store/demo";
import { DEMO_PEOPLE } from "@relay/store";
import superjson from "superjson";
import { z } from "zod";
import { createAuthentication } from "../src/server/auth.ts";
import { connections } from "../src/server/client-address.ts";
import { handleRpc } from "../src/server/rpc.ts";
import { limitKey } from "../src/server/rate-limit.ts";

const origin = "http://localhost:3405";
const email = "user-1@team.example";
const NativeSession = z
  .object({
    token: z.string().min(32),
    expiresAt: z.iso.datetime(),
    user: z.object({ id: z.uuid(), name: z.string(), role: z.string() }).strict(),
  })
  .strict();

function setup(store: Parameters<typeof createAuthentication>[0], demo = false) {
  const sent: { email: string; code: string }[] = [];
  const tasks: (() => Promise<void>)[] = [];
  const auth = createAuthentication(
    store,
    {
      baseUrl: origin,
      secret: "fake-native-test-secret-at-least-thirty-two-characters",
      trustedProxyCount: 0,
      globalLimit: 10_000,
      delivery: { kind: "developmentConsole" },
    },
    (message) => {
      sent.push(message);
      return Promise.resolve();
    },
    (task) => tasks.push(task),
    demo,
  );
  async function post(path: string, body: unknown, headers: HeadersInit = {}) {
    const started = performance.now();
    const response = await connections.run("127.0.0.1", () =>
      auth.handle(
        new Request(`${origin}/api/auth${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...Object.fromEntries(new Headers(headers)),
          },
          body: JSON.stringify(body),
        }),
      ),
    );
    const elapsed = performance.now() - started;
    for (const task of tasks.splice(0)) await task();
    if (path.startsWith("/native/")) {
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(response.headers.has("set-auth-token")).toBe(false);
      expect(
        [...response.headers.keys()].some((header) => header.startsWith("access-control-")),
      ).toBe(false);
    }
    return { response, elapsed };
  }
  const session = (headers: HeadersInit = {}) =>
    auth.handle(new Request(`${origin}/api/auth/get-session`, { headers }));
  async function signIn() {
    expect((await post("/native/send-code", { email })).response.status).toBe(200);
    const result = await post("/native/sign-in", { email, otp: sent.at(-1)?.code });
    expect(result.response.status, await result.response.clone().text()).toBe(200);
    expect(result.elapsed).toBeGreaterThanOrEqual(290);
    return NativeSession.parse(await result.response.json());
  }
  const rpc = (path: string, input: unknown = {}, headers: HeadersInit = {}, method = "GET") => {
    const encoded = JSON.stringify(superjson.serialize(input));
    const query = method === "GET" ? `?input=${encodeURIComponent(encoded)}` : "";
    const request = new Request(`${origin}/api/trpc/${path}${query}`, {
      method,
      headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
      ...(method === "POST" ? { body: encoded } : {}),
    });
    return handleRpc(
      request,
      async () => ({ store, principal: await auth.principal(request.headers) }),
      origin,
    );
  };
  return { auth, post, session, rpc, sent, signIn };
}

test("native email sign-in reads the queue, writes a note and revokes the same database session", async ({
  db,
}) => {
  const userId = await db.seedUser("agent");
  const teamId = await db.seedTeam("sales");
  await db.ownerRows("INSERT INTO memberships(user_id,team_id) VALUES ($1,$2)", [userId, teamId]);
  const id = await db.seedLead({
    email: "native-lead@example.com",
    lifecycle: {
      state: { status: "assigned", assignee: { ownerId: userId, teamId } },
      firstAssignedAt: new Date(),
      previousOwnerId: null,
    },
  });
  const { signIn, rpc, session, post } = setup(db.store);
  const signed = await signIn();
  const headers = { authorization: `Bearer ${signed.token}` };
  expect(signed.user).toMatchObject({ id: userId, role: "agent" });
  expect(Date.parse(signed.expiresAt) - Date.now()).toBeGreaterThan(86_390_000);
  expect(Date.parse(signed.expiresAt) - Date.now()).toBeLessThanOrEqual(86_400_000);
  expect(await db.rows("SELECT token FROM auth_sessions")).toEqual([{ token: signed.token }]);
  expect(await (await session(headers)).json()).toMatchObject({ user: signed.user });
  expect(await (await rpc("session.current", {}, headers)).json()).toMatchObject({
    result: {
      data: { json: { kind: "session", actor: { userId, role: "agent", team: { id: teamId } } } },
    },
  });
  const queue = await rpc("leads.queue", {}, headers);
  expect(queue.status).toBe(200);
  expect(await queue.text()).toContain(id);
  const note = await rpc(
    "leads.addNote",
    { id, key: "native-note", note: "Call tomorrow." },
    headers,
    "POST",
  );
  expect(note.status, await note.clone().text()).toBe(200);
  expect(
    await db.rows("SELECT count(*)::int AS count FROM activities WHERE lead_id=$1", [id]),
  ).toEqual([{ count: 1 }]);
  await db.rows("UPDATE users SET role='teamLead' WHERE id=$1", [userId]);
  expect(await (await session(headers)).json()).toMatchObject({ user: { role: "teamLead" } });
  await db.ownerRows("DELETE FROM memberships WHERE user_id=$1", [userId]);
  expect(await (await rpc("session.current", {}, headers)).json()).toMatchObject({
    result: { data: { json: { actor: { role: "teamLead", team: null } } } },
  });
  expect((await post("/native/sign-out", {}, headers)).response.status).toBe(200);
  expect(await db.rows("SELECT token FROM auth_sessions")).toEqual([]);
  expect((await rpc("session.current", {}, headers)).status).toBe(401);
  expect(await (await session(headers)).json()).toBeNull();
});

test(
  "native demo sign-in is gated and a demo reset ends its token",
  { timeout: 120_000 },
  async ({ db }) => {
    const seed = {
      ownerUrl: db.ownerConnectionString,
      appUrl: db.connectionString,
      today: new Date(),
      deliver: () => Promise.resolve({ state: "sent" as const }),
    };
    await seedDemo(seed);
    expect((await setup(db.store).post("/native/demo", { role: "agent" })).response.status).toBe(
      404,
    );
    const { post, rpc } = setup(db.store, true);
    const result = await post("/native/demo", { role: "agent" });
    expect(result.response.status).toBe(200);
    const signed = NativeSession.parse(await result.response.json());
    expect(signed.user).toEqual({
      id: DEMO_PEOPLE.agent.id,
      name: DEMO_PEOPLE.agent.name,
      role: "agent",
    });
    const headers = { authorization: `Bearer ${signed.token}` };
    expect((await rpc("session.current", {}, headers)).status).toBe(200);
    await resetDemo({ ...seed, demo: true });
    expect((await rpc("session.current", {}, headers)).status).toBe(401);
  },
);

test.for(["origin", "cookie", "sec-fetch-site"])(
  "every native route refuses the %s header, including empty values",
  async (header, { db }) => {
    const { post } = setup(db.store, true);
    for (const value of [
      header === "origin"
        ? origin
        : header === "cookie"
          ? "relay.session_token=fake"
          : "same-origin",
      "",
    ])
      for (const [path, body] of [
        ["/native/send-code", { email }],
        ["/native/sign-in", { email, otp: "123456" }],
        ["/native/demo", { role: "agent" }],
        ["/native/sign-out", {}],
      ] as const)
        expect((await post(path, body, { [header]: value })).response.status).toBe(403);
    expect(await db.rows("SELECT key FROM auth_request_limits")).toEqual([]);
  },
);

test("native routes accept only strict JSON bodies within the shared size limit and stay allowlisted", async ({
  db,
}) => {
  const { post, auth } = setup(db.store, true);
  for (const [path, body] of [
    ["/native/send-code", { email }],
    ["/native/sign-in", { email, otp: "123456" }],
    ["/native/demo", { role: "agent" }],
    ["/native/sign-out", {}],
  ] as const) {
    expect((await post(path, body, { "content-type": "text/plain" })).response.status).toBe(415);
    expect(
      (await post(path, body, { "content-type": "application/x-www-form-urlencoded" })).response
        .status,
    ).toBe(415);
    expect((await post(path, { ...body, extra: true })).response.status).toBe(400);
    expect((await post(path, { pad: "x".repeat(100_001) })).response.status).toBe(413);
    expect((await auth.handle(new Request(`${origin}/api/auth${path}`))).status).toBe(404);
  }
  expect((await post("/native/send-code", { email, type: "sign-in" })).response.status).toBe(400);
  expect((await post("/native/sign-out", {})).response.status).toBe(401);
  for (const path of [
    "/native/sign-up",
    "/native/get-session",
    "/native/demo/",
    "/native/sign-in/email-otp",
  ])
    expect((await post(path, {})).response.status).toBe(404);
});

test("mixed bearer requests are refused and cookie mutations still require the configured origin", async ({
  db,
}) => {
  await db.seedUser("agent");
  const { signIn, post, session, rpc, sent } = setup(db.store);
  const signed = await signIn();
  for (const extra of [{ cookie: "" }, { origin }, { origin: "https://outside.example" }]) {
    const headers = { authorization: `Bearer ${signed.token}`, ...extra };
    expect((await session(headers)).status).toBe(403);
    expect((await rpc("session.current", {}, headers)).status).toBe(403);
    expect((await rpc("leads.addNote", {}, headers, "POST")).status).toBe(403);
  }
  await post("/email-otp/send-verification-otp", { email, type: "sign-in" }, { origin });
  const browser = await post("/sign-in/email-otp", { email, otp: sent.at(-1)?.code }, { origin });
  const cookie = browser.response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  expect(cookie).toContain("relay.session_token=");
  for (const headers of [{ cookie }, { cookie, origin: "https://outside.example" }])
    expect((await rpc("leads.addNote", {}, headers, "POST")).status).toBe(403);
  expect((await rpc("session.current", {}, { cookie })).status).toBe(200);
});

test("missing, malformed, unknown, expired and signed-out tokens have identical unauthorized bodies", async ({
  db,
}) => {
  await db.seedUser("agent");
  const { signIn, rpc, session, post } = setup(db.store);
  const absent = await (await rpc("session.current")).text();
  const check = async (authorization: string) => {
    const response = await rpc("session.current", {}, { authorization });
    expect(response.status).toBe(401);
    expect(await response.text()).toBe(absent);
    expect(await (await session({ authorization })).json()).toBeNull();
  };
  for (const token of [
    "",
    "Bearer",
    "Basic abc",
    "Bearer bad token",
    "Bearer %%%%",
    `Bearer ${"x".repeat(32)}`,
  ])
    await check(token);
  const expired = await signIn();
  await db.rows("UPDATE auth_sessions SET expires_at=now()-interval '1 second'");
  await check(`Bearer ${expired.token}`);
  const revoked = await signIn();
  const headers = { authorization: `Bearer ${revoked.token}` };
  expect((await post("/native/sign-out", {}, headers)).response.status).toBe(200);
  await check(headers.authorization);
});

test("browser and native sends consume one normalized per-email budget and retain the timing floor", async ({
  db,
}) => {
  await db.seedUser("agent");
  const { post } = setup(db.store);
  for (const [path, body, headers] of [
    ["/email-otp/send-verification-otp", { email, type: "sign-in" }, { origin }],
    ["/native/send-code", { email: "User-1@Team.Example" }, {}],
    ["/email-otp/send-verification-otp", { email, type: "sign-in" }, { origin }],
    ["/native/send-code", { email }, {}],
  ] as const) {
    const result = await post(path, body, headers);
    expect(result.response.status).toBe(
      path === "/native/send-code" && body.email === email ? 429 : 200,
    );
    expect(result.elapsed).toBeGreaterThanOrEqual(290);
  }
  expect(
    (await post("/email-otp/send-verification-otp", { email, type: "sign-in" }, { origin }))
      .response.status,
  ).toBe(429);
});

test.for(["auth:client", "auth:global", "verify"])(
  "native sign-in shares the %s counter with browser sign-in",
  async (counter, { db }) => {
    const { post } = setup(db.store);
    const key =
      counter === "auth:global"
        ? counter
        : limitKey(counter, counter === "verify" ? email : "127.0.0.1");
    const max = counter === "auth:global" ? 10_000 : counter === "verify" ? 10 : 20;
    await db.rows("INSERT INTO auth_request_limits(key,count,started_at) VALUES ($1,$2,now())", [
      key,
      max - 1,
    ]);
    expect(
      (await post("/sign-in/email-otp", { email, otp: "123456" }, { origin })).response.status,
    ).toBe(400);
    expect((await post("/native/sign-in", { email, otp: "123456" })).response.status).toBe(429);
  },
);

test("unknown native addresses match known addresses without mail or sessions", async ({ db }) => {
  await db.seedUser("agent");
  const { post, sent } = setup(db.store);
  const known = await post("/native/send-code", { email });
  const unknown = await post("/native/send-code", { email: "unknown@example.com" });
  expect(unknown.response.status).toBe(known.response.status);
  expect(await unknown.response.json()).toEqual(await known.response.json());
  expect(known.elapsed).toBeGreaterThanOrEqual(290);
  expect(unknown.elapsed).toBeGreaterThanOrEqual(290);
  expect(sent).toHaveLength(1);
  const refusals = [];
  for (const address of [email, "unknown@example.com"]) {
    const result = await post("/native/sign-in", { email: address, otp: "abcdef" });
    expect(result.response.status).toBe(400);
    refusals.push(await result.response.json());
    const wrong = await post("/native/sign-in", {
      email: address,
      otp: "999999" === sent[0]?.code ? "111111" : "999999",
    });
    expect(wrong.response.status).toBe(400);
    refusals.push(await wrong.response.json());
  }
  expect(refusals[2]).toEqual(refusals[0]);
  expect(refusals[3]).toEqual(refusals[1]);
  expect(await db.rows("SELECT user_id FROM auth_sessions")).toEqual([]);
  expect(
    await db.rows("SELECT identifier FROM auth_verifications WHERE identifier LIKE '%unknown%'"),
  ).toEqual([]);
});

test("successful, refused and failing bearer requests never log their token", async ({ db }) => {
  await db.seedUser("agent");
  const spies = [
    vi.spyOn(console, "error"),
    vi.spyOn(console, "info"),
    vi.spyOn(console, "log"),
    vi.spyOn(console, "warn"),
  ].map((spy) => spy.mockImplementation(() => undefined));
  try {
    const { signIn, rpc } = setup(db.store);
    const { token } = await signIn();
    const headers = { authorization: `Bearer ${token}` };
    expect((await rpc("session.current", {}, headers)).status).toBe(200);
    expect(
      (await rpc("session.current", {}, { authorization: `Bearer ${"z".repeat(32)}` })).status,
    ).toBe(401);
    const failing = setup({
      ...db.store,
      sessionPrincipal: () => {
        throw new Error(`Failed with secret ${token}`);
      },
    });
    expect((await failing.rpc("session.current", {}, headers)).status).toBe(500);
    expect(spies.some((spy) => spy.mock.calls.length > 0)).toBe(true);
    expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain(token);
    expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain("z".repeat(32));
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
