import { connect, transact } from "../src/tx.ts";
import { idempotent } from "../src/idempotency.ts";
import { expect } from "vitest";
import { test } from "../src/testing/index.ts";
import type { Actor } from "@relay/domain";

test("distribution stores its receipt in the shared user key scope", async ({ db }) => {
  const actor: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
  const ownerId = await db.seedUser("agent");
  const teamId = await db.seedTeam("sales");
  await db.rows("INSERT INTO memberships(user_id,team_id) VALUES ($1,$2)", [ownerId, teamId]);
  const leadId = await db.seedLead({
    email: "pool@example.com",
    lifecycle: { state: { status: "new" }, firstAssignedAt: null, previousOwnerId: null },
  });
  const preview = await db.store.previewDistribution(actor, {
    leadIds: [leadId],
    agents: [{ ownerId, teamId }],
    excludePreviousOwner: false,
  });
  const result = await db.store.submitDistribution(
    actor,
    {
      previewId: preview.id,
      fingerprint: preview.fingerprint,
      key: "one",
    },
    "00000000-0000-4000-8000-000000000001",
  );
  expect(await db.rows("SELECT scope,key,operation,result FROM idempotency_records")).toEqual([
    { scope: `user:${actor.userId}`, key: "one", operation: "distribution.submit", result },
  ]);
});

test("system keys replay canonical input, refuse different input and operations, and isolate job scopes", async ({
  db,
}) => {
  const client = connect(db.connectionString);
  const principal = { kind: "system", name: "providerWebhook" } as const;
  const input = {
    key: "event-1",
    operation: "record",
    request: { b: [1, 2], a: { z: true, y: null } },
  };
  const first = { outcome: "recorded" };
  const mustReplay = () => Promise.reject(new Error("Executed a completed request"));
  try {
    expect(
      await transact(client, (tx) =>
        idempotent(
          tx,
          principal,
          input,
          (value) => value,
          () => Promise.resolve(first),
        ),
      ),
    ).toEqual(first);
    const reordered = { ...input, request: { a: { y: null, z: true }, b: [1, 2] } };
    expect(
      await transact(client, (tx) =>
        idempotent(tx, principal, reordered, (value) => value, mustReplay),
      ),
    ).toEqual(first);
    for (const other of [
      { ...input, request: { b: [2, 1], a: { z: true, y: null } } },
      { ...input, operation: "other" },
    ]) {
      await expect(
        transact(client, (tx) => idempotent(tx, principal, other, (value) => value, mustReplay)),
      ).rejects.toMatchObject({ code: "idempotencyConflict" });
    }
    expect(
      await transact(client, (tx) =>
        idempotent(
          tx,
          { kind: "system", name: "reconciler" },
          input,
          (value) => value,
          () => Promise.resolve({ outcome: "separate" }),
        ),
      ),
    ).toEqual({ outcome: "separate" });
    await expect(db.rows("UPDATE idempotency_records SET key='changed'")).rejects.toThrow(
      "append-only",
    );
    await expect(db.rows("DELETE FROM idempotency_records")).rejects.toThrow("append-only");
    expect(await db.rows("SELECT count(*)::int AS count FROM users")).toEqual([{ count: 0 }]);
  } finally {
    await client.$disconnect();
  }
});

test("a failed request leaves no key and the next attempt can commit", async ({ db }) => {
  const client = connect(db.connectionString);
  const principal = { kind: "system", name: "reconciler" } as const;
  const input = { key: "retry", operation: "record", request: { id: 1 } };
  try {
    await expect(
      transact(client, (tx) =>
        idempotent(
          tx,
          principal,
          input,
          (value) => value,
          () => Promise.reject(new Error("failed")),
        ),
      ),
    ).rejects.toThrow("failed");
    expect(await db.rows("SELECT key FROM idempotency_records")).toEqual([]);
    expect(
      await transact(client, (tx) =>
        idempotent(
          tx,
          principal,
          input,
          (value) => value,
          () => Promise.resolve({ ok: true }),
        ),
      ),
    ).toEqual({ ok: true });
  } finally {
    await client.$disconnect();
  }
});

test("assignment audit stores JSON snapshots, a typed subject and its idempotency cause", async ({
  db,
}) => {
  const actor: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
  const ownerId = await db.seedUser("agent");
  const teamId = await db.seedTeam("sales");
  await db.rows("INSERT INTO memberships(user_id,team_id) VALUES ($1,$2)", [ownerId, teamId]);
  const leadId = await db.seedLead({
    email: "audit@example.com",
    lifecycle: { state: { status: "new" }, firstAssignedAt: null, previousOwnerId: null },
  });
  const preview = await db.store.previewDistribution(actor, {
    leadIds: [leadId],
    agents: [{ ownerId, teamId }],
    excludePreviousOwner: false,
  });
  const input = { previewId: preview.id, fingerprint: preview.fingerprint, key: "audit" };
  await db.store.submitDistribution(actor, input, "00000000-0000-4000-8000-000000000001");
  const [audit] = await db.rows("SELECT before,after FROM audit_log");
  expect(audit?.before).toEqual({
    lifecycle: { state: { status: "new" }, firstAssignedAt: null, previousOwnerId: null },
  });
  expect(
    await db.rows(
      "SELECT a.subject_type,a.subject_id,a.request_id='00000000-0000-4000-8000-000000000001'::uuid AS request_matches,a.idempotency_id=i.id AS receipt_matches FROM audit_log a JOIN idempotency_records i ON a.idempotency_id=i.id",
    ),
  ).toEqual([
    { subject_type: "lead", subject_id: leadId, request_matches: true, receipt_matches: true },
  ]);
  await db.store.submitDistribution(actor, input, "00000000-0000-4000-8000-000000000001");
  expect(await db.rows("SELECT count(*)::int AS count FROM audit_log")).toEqual([{ count: 1 }]);
});

test("first result and replay both decode the stored JSON value", async ({ db }) => {
  const client = connect(db.connectionString);
  const input = { key: "date", operation: "record", request: {} };
  try {
    const run = () =>
      transact(client, (tx) =>
        idempotent(
          tx,
          { kind: "system", name: "reconciler" },
          input,
          (value) => value,
          () => Promise.resolve({ at: new Date("2026-11-16T00:00:00Z") }),
        ),
      );
    const first = await run();
    const replay = await run();
    expect(first).toEqual(replay);
    expect(first).toEqual({ at: "2026-11-16T00:00:00.000Z" });
  } finally {
    await client.$disconnect();
  }
});

test("idempotency request hashes cannot be null", async ({ db }) => {
  await expect(
    db.rows(
      "INSERT INTO idempotency_records(id,scope,key,operation,result) VALUES (gen_random_uuid(),'system:reconciler','missing','test','{}')",
    ),
  ).rejects.toMatchObject({ code: "23502" });
});
