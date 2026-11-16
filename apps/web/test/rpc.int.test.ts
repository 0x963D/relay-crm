import { expect, describe, vi } from "vitest";
import { test } from "@relay/store/testing";
import type { Actor, SessionPrincipal } from "@relay/domain";
import superjson from "superjson";
import { appRouter, handleRpc, type RpcContext } from "../src/server/rpc.ts";

const origin = "http://localhost:3402";
function principal(actor: Actor): SessionPrincipal {
  return { kind: "development", actor };
}
async function rpc(
  context: RpcContext,
  path: string,
  input: unknown,
  method = "GET",
  requestOrigin = origin,
) {
  const encoded = superjson.serialize(input);
  const query = method === "GET" ? `?input=${encodeURIComponent(JSON.stringify(encoded))}` : "";
  return handleRpc(
    new Request(`${origin}/api/trpc/${path}${query}`, {
      method,
      headers: { origin: requestOrigin, "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(encoded) } : {}),
    }),
    () => Promise.resolve(context),
    origin,
  );
}

describe("typed RPC", () => {
  test("requires a session and parses input before invoking a store operation", async ({ db }) => {
    const context = { store: db.store, principal: null };
    expect((await rpc(context, "leads.list", { limit: 10 })).status).toBe(401);
    const actor: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
    const signed = { ...context, principal: principal(actor) };
    expect(
      (await rpc(signed, "leads.assign", { leadIds: ["not-an-id"], to: {} }, "POST")).status,
    ).toBe(400);
    expect(
      (await rpc(signed, "leads.assign", {}, "POST", "https://untrusted.example")).status,
    ).toBe(403);
  });
  test("returns dates through superjson and turns out-of-scope operations into typed access errors", async ({
    db,
  }) => {
    const userId = await db.seedUser("agent");
    const other = await db.seedUser("agent");
    const teamId = await db.seedTeam("sales");
    const actor: Actor = { userId, role: "agent", team: null };
    const id = await db.seedLead({
      email: "other@example.com",
      lifecycle: {
        state: { status: "assigned", assignee: { ownerId: other, teamId } },
        firstAssignedAt: new Date(),
        previousOwnerId: null,
      },
    });
    const mine = await db.seedLead({
      email: "mine@example.com",
      lifecycle: {
        state: { status: "assigned", assignee: { ownerId: userId, teamId } },
        firstAssignedAt: new Date(),
        previousOwnerId: null,
      },
    });
    const context = { store: db.store, principal: principal(actor) };
    const listed = await rpc(context, "leads.list", { limit: 100 });
    expect(listed.status).toBe(200);
    const body: unknown = await listed.json();
    expect(body).toMatchObject({
      result: { data: { json: [{ id: mine }], meta: { values: { "0.createdAt": ["Date"] } } } },
    });
    for (const path of ["leads.get", "leads.edit", "leads.assign", "leads.reassign"]) {
      const method = path === "leads.get" ? "GET" : "POST";
      const input =
        path === "leads.get"
          ? { id }
          : path === "leads.edit"
            ? { id, name: "forbidden", phone: null }
            : path === "leads.assign"
              ? { leadIds: [id], to: { ownerId: userId, teamId } }
              : { leadId: id, to: { ownerId: userId, teamId } };
      const denied = await rpc(context, path, input, method);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({
        error: { json: { data: { code: "FORBIDDEN", accessFailure: "accessDenied" } } },
      });
    }
  });
  test("assigns through the API and reports stale previews as conflicts", async ({ db }) => {
    const userId = await db.seedUser("manager"),
      agentId = await db.seedUser("agent"),
      teamId = await db.seedTeam("sales");
    await db.ownerRows("INSERT INTO memberships(user_id,team_id) VALUES ($1,$2)", [
      agentId,
      teamId,
    ]);
    const actor: Actor = { userId, role: "manager", team: null };
    const id = await db.seedLead({
      email: "pool@example.com",
      lifecycle: { state: { status: "new" }, firstAssignedAt: null, previousOwnerId: null },
    });
    const context = { store: db.store, principal: principal(actor) };
    const caller = appRouter.createCaller(context);
    const preview = await caller.distribution.preview({
      leadIds: [id],
      agents: [{ ownerId: agentId, teamId }],
      excludePreviousOwner: false,
    });
    const assigned = await rpc(
      context,
      "leads.assign",
      { leadIds: [id], to: { ownerId: agentId, teamId } },
      "POST",
    );
    expect(assigned.status).toBe(200);
    const requestId = assigned.headers.get("x-request-id");
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(
      await db.ownerRows("SELECT request_id FROM audit_log WHERE subject_id=$1", [id]),
    ).toEqual([{ request_id: requestId }]);
    expect(
      await db.rows("SELECT detail->>'requestId' AS request_id FROM activities WHERE lead_id=$1", [
        id,
      ]),
    ).toEqual([{ request_id: requestId }]);
    const stale = await rpc(
      context,
      "distribution.submit",
      { previewId: preview.id, fingerprint: preview.fingerprint, key: "stale-api" },
      "POST",
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { json: { data: { code: "CONFLICT", accessFailure: "stalePreview" } } },
    });
    expect((await caller.leads.get({ id })).lifecycle.state).toEqual({
      status: "assigned",
      assignee: { ownerId: agentId, teamId },
    });
  });
});

test("production RPC errors hide internal messages and correlate the server log", async ({
  db,
}) => {
  const actor: Actor = { userId: await db.seedUser("owner"), role: "owner", team: null };
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubEnv("NODE_ENV", "production");
  try {
    const response = await rpc(
      {
        store: {
          ...db.store,
          listLeads: () => {
            throw new Error("database password leaked in this message");
          },
        },
        principal: principal(actor),
      },
      "leads.list",
      { limit: 10 },
    );
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain("database password leaked in this message");
    expect(body).toContain("Something went wrong.");
    const requestId = /"requestId":"([^"]+)"/.exec(body)?.[1];
    expect(requestId).toBe(response.headers.get("x-request-id"));
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
    if (!requestId) throw new Error("No request ID");
    expect(log).toHaveBeenCalledWith(expect.stringContaining(requestId));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"class":"Error"'));
    expect(log).not.toHaveBeenCalledWith(
      expect.stringContaining("database password leaked in this message"),
    );
  } finally {
    log.mockRestore();
    vi.unstubAllEnvs();
  }
});

test("RPC rejects an oversized JSON body before context or parsing", async ({ db }) => {
  const context = vi.fn(() => Promise.resolve({ store: db.store, principal: null }));
  const response = await handleRpc(
    new Request(`${origin}/api/trpc/leads.edit`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(2_000_000) }),
    }),
    context,
    origin,
  );
  expect(response.status).toBe(413);
  expect(context).not.toHaveBeenCalled();
});

test("work endpoints parse commands, preserve callback dates and carry the HTTP request ID", async ({
  db,
}) => {
  const userId = await db.seedUser("agent");
  const teamId = await db.seedTeam("sales");
  await db.ownerRows("INSERT INTO memberships(user_id,team_id) VALUES ($1,$2)", [userId, teamId]);
  const actor: Actor = { userId, role: "agent", team: null };
  const id = await db.seedLead({
    email: "work-api@example.com",
    lifecycle: {
      state: { status: "assigned", assignee: { ownerId: userId, teamId } },
      firstAssignedAt: new Date(),
      previousOwnerId: null,
    },
  });
  const context = { store: db.store, principal: principal(actor), timeZone: "Asia/Tokyo" };
  const at = new Date("2099-11-17T09:30:00Z");
  const attempt = await rpc(
    context,
    "leads.logAttempt",
    {
      id,
      key: "call",
      channel: "call",
      outcome: "noAnswer",
      note: "Rang out",
      callback: { kind: "set", at },
    },
    "POST",
  );
  expect(attempt.status).toBe(200);
  const requestId = attempt.headers.get("x-request-id");
  expect(await db.ownerRows("SELECT request_id FROM audit_log WHERE subject_id=$1", [id])).toEqual([
    { request_id: requestId },
  ]);
  expect(
    await db.rows("SELECT detail->>'requestId' AS request_id FROM activities WHERE lead_id=$1", [
      id,
    ]),
  ).toEqual([{ request_id: requestId }]);
  expect((await db.store.getLead(actor, id)).lifecycle.state).toMatchObject({
    stage: { kind: "callBack", at },
  });
  expect((await db.store.getLead(actor, id)).contactedAt).toBeNull();
  for (const [path, input] of [
    [
      "leads.logAttempt",
      { id, key: "bad", channel: "email", outcome: "noAnswer", note: "Invalid channel" },
    ],
    [
      "leads.logAttempt",
      { id, key: "bad", channel: "call", outcome: "contacted", note: "Invalid outcome" },
    ],
    ["leads.addNote", { id, key: "bad", note: " " }],
    ["leads.setCallback", { id, key: "bad", change: { kind: "set", at: "2099-11-17" } }],
    ["leads.close", { id, key: "bad", closing: { kind: "lost", note: " " } }],
    ["leads.close", { id, key: "bad", closing: { kind: "dead", reason: "badTiming" } }],
  ] as const)
    expect((await rpc(context, path, input, "POST")).status).toBe(400);
  const caller = appRouter.createCaller(context);
  await caller.leads.addNote({ id, key: "note", note: "Asked for the Saturday class" });
  await caller.leads.setCallback({ id, key: "clear", change: { kind: "clear" } });
  expect((await caller.leads.queue({})).timeZone).toBe("Asia/Tokyo");
  await caller.leads.logAttempt({
    id,
    key: "spoke",
    channel: "whatsApp",
    outcome: "spokeToThem",
    note: "Discussed the class",
  });
  await caller.leads.close({
    id,
    key: "lost",
    closing: { kind: "lost", note: "Starts next year" },
  });
  expect((await caller.leads.get({ id })).lostNote).toBe("Starts next year");
});
