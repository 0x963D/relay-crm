import { expect } from "vitest";
import { submissionExample } from "@relay/domain/testing";
import { type Actor } from "@relay/domain";
import { randomUUID } from "node:crypto";
import { test, type TestDatabase } from "../src/testing/index.ts";
import { APPEND_ONLY_TABLES } from "./append-only-tables.ts";

async function history(db: TestDatabase) {
  const actor: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
  await db.store.intake(submissionExample());
  const money = { minor: 39500n, currency: "GBP" } as const;
  const payment = await db.store.createPayment(
    actor,
    {
      key: "fake-append-card",
      accountId: await db.seedAccount(),
      money,
      kind: "first",
      mode: "drop",
    },
    0,
    randomUUID(),
  );
  await db.store.receivePaymentWebhook({
    paymentId: payment.id,
    eventId: randomUUID(),
    payloadHash: "fake-append-payload",
    observed: { status: "completed", money },
  });
  await db.store.recordManualPayment(
    actor,
    {
      key: "fake-append-manual",
      accountId: await db.seedAccount(),
      money,
      kind: "first",
      receiptHash: "a".repeat(64),
      reference: "fake-append-receipt",
    },
    randomUUID(),
  );
  await db.ownerRows(
    "INSERT INTO distribution_previews(id,actor_id,fingerprint,request,snapshot) VALUES(gen_random_uuid(),$1,'fake-fingerprint','{}','[]')",
    [actor.userId],
  );
}

test.for(APPEND_ONLY_TABLES)("owner append-only %s", async ([table, column], { db }) => {
  await history(db);
  expect(await db.ownerRows(`SELECT 1 FROM ${table} LIMIT 1`)).toHaveLength(1);
  for (const statement of [`UPDATE ${table} SET ${column}=${column}`, `DELETE FROM ${table}`])
    await expect(db.ownerRows(statement)).rejects.toMatchObject({
      code: "23001",
      message: `${table} is append-only`,
    });
});

test("the trigger catalog contains every enabled append-only row guard", async ({ db }) => {
  expect(
    await db.ownerRows(
      "SELECT tgname AS name,tgtype::int AS type,tgenabled AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT tgisinternal AND tgname LIKE '%_append_only' ORDER BY tgname",
    ),
  ).toEqual(
    APPEND_ONLY_TABLES.map(([table]) => ({ name: `${table}_append_only`, type: 27, enabled: "O" })),
  );
});
