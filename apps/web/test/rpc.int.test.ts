import { expect, describe } from "vitest";
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
    await db.rows("INSERT INTO memberships(user_id,team_id) VALUES ($1,$2)", [agentId, teamId]);
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
