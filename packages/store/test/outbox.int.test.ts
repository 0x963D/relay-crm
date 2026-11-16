import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { Actor, DeliveryOutcome } from "@relay/domain";
import { test, type TestDatabase } from "../src/testing/index.ts";
const latch = (): PromiseWithResolvers<void> => Promise.withResolvers();
const at = new Date("2030-01-01T00:00:00Z");
const requestId = "00000000-0000-4000-8000-000000000001";
async function receipt(db: TestDatabase, suffix = "one") {
  const actor: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
  const accountId = await db.seedAccount();
  const { id } = await db.store.createPayment(
    actor,
    {
      key: randomUUID(),
      accountId,
      money: { minor: 48000n, currency: "GBP" },
      kind: "first",
      mode: "drop",
    },
    0,
    requestId,
  );
  await db.store.receivePaymentWebhook({
    eventId: randomUUID(),
    paymentId: id,
    payloadHash: "fake",
    observed: { status: "completed", money: { minor: 48000n, currency: "GBP" } },
  });
  const detail = await db.store.getPayment(actor, id);
  if (!detail.receipt) throw new Error("No outbox row");
  await db.rows("UPDATE outbox SET recipient=$1 WHERE id=$2", [
    `${suffix}@example.com`,
    detail.receipt.id,
  ]);
  return { actor, id, outboxId: detail.receipt.id };
}
test("two workers collide and deliver every row once", async ({ db }) => {
  const a = await receipt(db),
    b = await receipt(db, "two");
  const entered = latch(),
    release = latch();
  const deliveries: string[] = [];
  const send = async (message: { id: string }): Promise<DeliveryOutcome> => {
    deliveries.push(message.id);
    if (deliveries.length === 1) {
      entered.resolve();
      await release.promise;
    }
    return { state: "sent" };
  };
  const first = db.store.runOutbox(send, { at });
  await entered.promise;
  try {
    expect(await db.store.runOutbox(send, { at })).toHaveLength(1);
  } finally {
    release.resolve();
  }
  await first;
  expect(deliveries.sort()).toEqual([a.outboxId, b.outboxId].sort());
  expect(await db.rows("SELECT state,attempts FROM outbox ORDER BY id")).toEqual([
    { state: "sent", attempts: 1 },
    { state: "sent", attempts: 1 },
  ]);
});
test("a worker stopped after leasing is recovered after expiry", async ({ db }) => {
  const w = await receipt(db);
  const leased = await db.store.leaseReceipt(w.outboxId, at, 60_000);
  expect(leased?.leaseToken).toBeTruthy();
  let calls = 0;
  const send = (): Promise<DeliveryOutcome> => {
    calls++;
    return Promise.resolve({ state: "sent" });
  };
  expect(await db.store.runOutbox(send, { at: new Date(at.getTime() + 59_999) })).toEqual([]);
  expect(await db.store.runOutbox(send, { at: new Date(at.getTime() + 60_000) })).toHaveLength(1);
  expect(calls).toBe(1);
});
test("an expired lease cannot overlap an in-flight sender even after explicit requeue", async ({
  db,
}) => {
  const w = await receipt(db);
  const entered = latch(),
    release = latch();
  let calls = 0;
  const send = async (): Promise<DeliveryOutcome> => {
    calls++;
    entered.resolve();
    await release.promise;
    return { state: "sent" };
  };
  const run = db.store.runOutbox(send, { at: new Date(0), leaseMs: 1 });
  await run;
  const first = db.store.runOutbox(send, { at: new Date(), leaseMs: 1 });
  await entered.promise;
  await db.rows("UPDATE outbox SET lease_until=now()-interval '1 second'");
  await db.store.requeueReceipt(w.actor, w.id, requestId);
  try {
    expect(await db.store.runOutbox(send, { at })).toEqual([]);
  } finally {
    release.resolve();
  }
  await first;
  expect(calls).toBe(1);
});
test("confirmed failures retry after 5, 10 and 20 minutes and stop at four attempts", async ({
  db,
}) => {
  const w = await receipt(db);
  const identities: string[] = [];
  const send = (message: { id: string }): Promise<DeliveryOutcome> => {
    identities.push(message.id);
    return Promise.resolve({ state: "failed", reason: "Mailbox refused delivery" });
  };
  let when = at;
  for (const minutes of [5, 10, 20]) {
    expect(await db.store.runOutbox(send, { at: when })).toHaveLength(1);
    const next = new Date(when.getTime() + minutes * 60_000);
    const view = await db.store.getPayment(w.actor, w.id);
    expect(view.receipt?.nextAttemptAt).toEqual(next);
    expect(await db.store.runOutbox(send, { at: new Date(next.getTime() - 1) })).toEqual([]);
    when = next;
  }
  await db.store.runOutbox(send, { at: when });
  expect(await db.store.runOutbox(send, { at: new Date(when.getTime() + 86400_000) })).toEqual([]);
  const view = await db.store.getPayment(w.actor, w.id);
  expect(view.receipt).toMatchObject({ state: "failed", attempts: 4, nextAttemptAt: null });
  expect(view.receipt?.history.map((h) => h.state)).toEqual([
    "failed",
    "failed",
    "failed",
    "failed",
  ]);
  expect(identities).toEqual(Array<string>(4).fill(w.outboxId));
  expect(view.state.status).toBe("completed");
});
test("unknown delivery never retries automatically and authorized requeue is audited", async ({
  db,
}) => {
  const w = await receipt(db);
  await db.store.runOutbox(
    () => Promise.resolve({ state: "unknown", reason: "Connection dropped" }),
    { at },
  );
  const noSend = () => Promise.reject(new Error("Must not retry"));
  expect(await db.store.runOutbox(noSend, { at: new Date(at.getTime() + 86400_000) })).toEqual([]);
  const agent: Actor = { userId: await db.seedUser("agent"), role: "agent", team: null };
  await expect(db.store.requeueReceipt(agent, w.id, requestId)).rejects.toMatchObject({
    code: "accessDenied",
  });
  await db.store.requeueReceipt(w.actor, w.id, requestId);
  await db.store.runOutbox(() => Promise.resolve({ state: "sent" }), { at });
  const view = await db.store.getPayment(w.actor, w.id);
  expect(view.receipt).toMatchObject({ state: "sent", attempts: 2 });
  expect(view.receipt?.history.map((h) => h.state)).toEqual(["unknown", "sent"]);
  expect(await db.rows("SELECT request_id FROM audit_log WHERE action='receiptRequeued'")).toEqual([
    { request_id: requestId },
  ]);
});
test("suppressed addresses send nothing and keep the completed payment", async ({ db }) => {
  const w = await receipt(db);
  await db.rows(
    "INSERT INTO email_suppressions(email,reason) VALUES ('one@example.com','Earlier bounce')",
  );
  const result = await db.store.runOutbox(() => Promise.reject(new Error("Must not send")), { at });
  expect(result).toEqual([{ id: w.outboxId, state: "suppressed" }]);
  const view = await db.store.getPayment(w.actor, w.id);
  expect(view.receipt).toMatchObject({ state: "suppressed", attempts: 0, nextAttemptAt: null });
  expect(view.receipt?.history[0]?.reason).toBe("Earlier bounce");
  expect(view.state.status).toBe("completed");
  await expect(db.store.requeueReceipt(w.actor, w.id, requestId)).rejects.toMatchObject({
    code: "refreshConflict",
  });
});
