import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { Actor, DeliveryOutcome } from "@relay/domain";
import { openStore } from "../src/index.ts";
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
  const deliveries: string[] = [];
  const send = (message: { id: string }): Promise<DeliveryOutcome> => {
    deliveries.push(message.id);
    return Promise.resolve({ state: "sent" });
  };
  await db.gate.close("outbox");
  const workers = Promise.all([db.store.runOutbox(send, { at }), db.store.runOutbox(send, { at })]);
  try {
    await db.gate.waitForWaiters(2);
  } finally {
    await db.gate.open();
  }
  await workers;
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
test("an unexpired lease excludes requeue and another sender after database sessions close", async ({
  db,
}) => {
  const w = await receipt(db);
  const entered = latch();
  let active = 0;
  let maximum = 0;
  const workerUrl = new URL(db.connectionString);
  workerUrl.searchParams.set("application_name", "receipt-worker-test");
  const worker = openStore({ connectionString: workerUrl.toString() });
  const first = worker.runOutbox(
    async (_message, signal) => {
      active++;
      maximum = Math.max(maximum, active);
      entered.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
      });
      active--;
      return { state: "unknown", reason: "Send aborted" };
    },
    { leaseMs: 2000, sendTimeoutMs: 1000 },
  );
  try {
    await entered.promise;
    const closed = await db.rows(
      "SELECT pg_terminate_backend(pid) AS closed FROM pg_stat_activity WHERE datname=current_database() AND usename='relay_app' AND state='idle' AND application_name='receipt-worker-test'",
    );
    expect(closed.length).toBeGreaterThan(0);
    expect(closed.every((row) => row.closed === true)).toBe(true);
    await expect(db.store.requeueReceipt(w.actor, w.id, requestId)).rejects.toMatchObject({
      code: "refreshConflict",
    });
    expect(await db.store.runOutbox(() => Promise.resolve({ state: "sent" }))).toEqual([]);
    expect(await first).toEqual([{ id: w.outboxId, state: "unknown" }]);
    expect(active).toBe(0);
    await db.store.requeueReceipt(w.actor, w.id, requestId);
    await db.store.runOutbox(() => {
      active++;
      maximum = Math.max(maximum, active);
      active--;
      return Promise.resolve({ state: "sent" });
    });
    expect(maximum).toBe(1);
  } finally {
    await first;
    await worker.close();
  }
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

test("a receipt without an address is suppressed without sending or retrying", async ({ db }) => {
  const w = await receipt(db);
  await db.rows("UPDATE outbox SET recipient=NULL WHERE id=$1", [w.outboxId]);
  let calls = 0;
  const send = () => {
    calls++;
    return Promise.resolve({ state: "failed" as const, reason: "No address" });
  };
  expect(await db.store.runOutbox(send, { at })).toEqual([{ id: w.outboxId, state: "suppressed" }]);
  expect(await db.store.runOutbox(send, { at: new Date(at.getTime() + 86400000) })).toEqual([]);
  expect(calls).toBe(0);
  const detail = await db.store.getPayment(w.actor, w.id);
  expect(detail.receipt).toMatchObject({ state: "suppressed", attempts: 0, nextAttemptAt: null });
  expect(detail.receipt?.history[0]).toMatchObject({ state: "suppressed", reason: "no address" });
});

test("a lost lease token never reports an unrecorded send as sent", async ({ db }) => {
  const w = await receipt(db);
  const results = await db.store.runOutbox(
    async () => {
      await db.rows("UPDATE outbox SET lease_token=gen_random_uuid() WHERE id=$1", [w.outboxId]);
      return { state: "sent" };
    },
    { at },
  );
  expect(results).toEqual([{ id: w.outboxId, state: "superseded" }]);
  expect((await db.store.getPayment(w.actor, w.id)).receipt?.state).toBe("unknown");
});

test("one outcome recording failure is recorded and the batch continues", async ({ db }) => {
  const a = await receipt(db, "first"),
    b = await receipt(db, "second");
  await db.rows("UPDATE outbox SET next_attempt_at='2000-01-01' WHERE id=$1", [a.outboxId]);
  await db.ownerRows(
    `CREATE FUNCTION fail_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.outbox_id='${a.outboxId}'::uuid AND NEW.finished_at IS NOT NULL THEN RAISE EXCEPTION 'Fake storage failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_finish BEFORE UPDATE ON receipt_attempts FOR EACH ROW EXECUTE FUNCTION fail_finish()`,
  );
  const sent: string[] = [];
  const results = await db.store.runOutbox(
    (message) => {
      sent.push(message.id);
      return Promise.resolve({ state: "sent" });
    },
    { at },
  );
  expect(sent).toEqual([a.outboxId, b.outboxId]);
  expect(results).toEqual([
    { id: a.outboxId, state: "recordingFailed", failureRecorded: true },
    { id: b.outboxId, state: "sent" },
  ]);
  expect((await db.store.getPayment(a.actor, a.id)).receipt?.state).toBe("unknown");
  expect(
    await db.rows(
      "SELECT payment_id,detail FROM payment_events WHERE kind='receiptRecordingFailed'",
    ),
  ).toEqual([
    {
      payment_id: a.id,
      detail: { outboxId: a.outboxId, reason: "Could not record receipt delivery outcome." },
    },
  ]);
});

test("completed payment cannot commit without its receipt even with a valid posting", async ({
  db,
}) => {
  const actor: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
  const accountId = await db.seedAccount();
  const { id } = await db.store.createPayment(
    actor,
    {
      key: randomUUID(),
      accountId,
      money: { minor: 100n, currency: "GBP" },
      kind: "first",
      mode: "drop",
    },
    0,
    requestId,
  );
  await db.ownerRows("BEGIN");
  try {
    await db.ownerRows(
      "UPDATE payments SET status='completed',completed_by='reconciler',decided_at=now() WHERE id=$1",
      [id],
    );
    await db.ownerRows(
      `WITH customer AS (INSERT INTO ledger_accounts(id,account_id,kind,currency) VALUES (gen_random_uuid(),$2,'customer','GBP') RETURNING id),
  provider AS (INSERT INTO ledger_accounts(id,kind,currency) VALUES (gen_random_uuid(),'cardProviderSandbox','GBP') RETURNING id),
  posting AS (INSERT INTO ledger_transactions(id,payment_id,at) VALUES (gen_random_uuid(),$1,now()) RETURNING id)
  INSERT INTO ledger_lines(id,transaction_id,ledger_account_id,side,amount)
  SELECT gen_random_uuid(),posting.id,customer.id,'credit',100 FROM posting,customer UNION ALL SELECT gen_random_uuid(),posting.id,provider.id,'debit',100 FROM posting,provider`,
      [id, accountId],
    );
    await expect(db.ownerRows("COMMIT")).rejects.toMatchObject({
      code: "23514",
      constraint: "payment_outbox_required",
    });
  } finally {
    await db.ownerRows("ROLLBACK");
  }
  expect((await db.store.getPayment(actor, id)).state.status).toBe("checkoutCreated");
});

test("receipt rows cannot be deleted by the owner or restricted app role", async ({ db }) => {
  const w = await receipt(db);
  await expect(db.ownerRows("DELETE FROM outbox WHERE id=$1", [w.outboxId])).rejects.toMatchObject({
    code: "23001",
  });
  await expect(db.rows("DELETE FROM outbox WHERE id=$1", [w.outboxId])).rejects.toMatchObject({
    code: "42501",
  });
});

test("a completed payment cannot lose its receipt by moving it", async ({ db }) => {
  const w = await receipt(db),
    accountId = await db.seedAccount();
  const other = await db.store.createPayment(
    w.actor,
    {
      key: randomUUID(),
      accountId,
      money: { minor: 100n, currency: "GBP" },
      kind: "first",
      mode: "drop",
    },
    0,
    requestId,
  );
  await expect(
    db.rows("UPDATE outbox SET payment_id=$1 WHERE id=$2", [other.id, w.outboxId]),
  ).rejects.toMatchObject({ code: "23001" });
});
