import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { test } from "@relay/store/testing";
import { type Actor, type PaymentProvider } from "@relay/domain";
import { paymentWebhook, signPaymentBody } from "../src/server/payments/webhook.ts";
import { reconcilePayments } from "../src/server/payments/reconcile.ts";
import { sandboxProvider } from "../src/server/payments/sandbox.ts";
import { appRouter } from "../src/server/rpc.ts";

const secret = "fake-sandbox-webhook-secret-for-tests-only";
const env = {
  baseUrl: "http://127.0.0.1:1",
  webhookSecret: secret,
  reconcileSecret: "fake-reconcile-secret-for-tests-only",
  firstCheckMs: 0,
  intervalMs: 300000,
  lateMs: 0,
  checkoutTtlMs: 86400000,
};

test("the receiver rejects forged and stale signatures, replays event IDs, and records no event on failure", async ({
  db,
}) => {
  const actor: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
  const accountId = await db.seedAccount();
  const { id } = await db.store.createPayment(
    actor,
    {
      key: "signed",
      accountId,
      money: { minor: 100n, currency: "GBP" },
      kind: "first",
      mode: "normal",
    },
    0,
    "00000000-0000-4000-8000-000000000001",
  );
  const receiver = paymentWebhook(db.store, secret);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = {
    eventId: randomUUID(),
    paymentId: id,
    status: "completed",
    amount: "100",
    currency: "GBP",
  };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const request = (ts: string, signature: string, bytes = body) =>
    new Request("http://localhost/api/payments/webhook", {
      method: "POST",
      body: bytes,
      headers: { "x-sandbox-timestamp": ts, "x-sandbox-signature": signature },
    });
  expect((await receiver(request(timestamp, "0".repeat(64)))).status).toBe(401);
  const stale = (Number(timestamp) - 301).toString();
  expect((await receiver(request(stale, signPaymentBody(secret, stale, body)))).status).toBe(401);
  const future = (Number(timestamp) + 301).toString();
  expect((await receiver(request(future, signPaymentBody(secret, future, body)))).status).toBe(401);
  expect(await db.rows("SELECT * FROM webhook_inbox")).toHaveLength(0);
  for (let i = 0; i < 2; i += 1)
    expect(
      (await receiver(request(timestamp, signPaymentBody(secret, timestamp, body)))).status,
    ).toBe(200);
  expect(await db.rows("SELECT * FROM webhook_inbox")).toHaveLength(1);
  expect(await db.rows("SELECT * FROM ledger_transactions")).toHaveLength(1);
  expect(
    await db.rows(
      "SELECT detail->>'duplicate' AS duplicate FROM payment_events WHERE kind='webhookDelivery' ORDER BY sequence",
    ),
  ).toEqual([{ duplicate: "false" }, { duplicate: "true" }]);
  const changed = new TextEncoder().encode(JSON.stringify({ ...payload, amount: "101" }));
  expect(
    (await receiver(request(timestamp, signPaymentBody(secret, timestamp, changed), changed)))
      .status,
  ).toBe(500);
  const missing = new TextEncoder().encode(
    JSON.stringify({ ...payload, eventId: "missing", paymentId: randomUUID() }),
  );
  expect(
    (await receiver(request(timestamp, signPaymentBody(secret, timestamp, missing), missing)))
      .status,
  ).toBe(500);
  expect(await db.rows("SELECT * FROM webhook_inbox")).toHaveLength(1);
  expect((await receiver(request(timestamp, "0".repeat(64), new Uint8Array(100001)))).status).toBe(
    413,
  );
});

test("two reconcilers scanning the same candidates read each provider payment once", async ({
  db,
}) => {
  const actor: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
  const accountId = await db.seedAccount();
  const adapter = sandboxProvider(db.store, env);
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const { id } = await db.store.createPayment(
      actor,
      {
        key: String(i),
        accountId,
        money: { minor: 100n, currency: "GBP" },
        kind: "repeat",
        mode: "drop",
      },
      0,
      "00000000-0000-4000-8000-000000000001",
    );
    await adapter.createCheckout(await db.store.checkoutTerms(actor, id));
    await db.store.paySandboxCheckout(id);
    ids.push(id);
  }
  const { promise: gate, resolve: release } = Promise.withResolvers<boolean>();
  let scans = 0;
  const store = {
    ...db.store,
    duePayments: async (at: Date, limit: number) => {
      const candidates = await db.store.duePayments(at, limit);
      scans += 1;
      if (scans === 2) release(true);
      await gate;
      return candidates;
    },
  };
  const reads: string[] = [];
  const provider: PaymentProvider = {
    ...adapter,
    readPayment: async (id) => {
      reads.push(id);
      return adapter.readPayment(id);
    },
  };
  const runs = await Promise.all([
    reconcilePayments(store, provider, env.intervalMs),
    reconcilePayments(store, provider, env.intervalMs),
  ]);
  expect(runs.flat()).toHaveLength(3);
  expect(reads.sort()).toEqual(ids.sort());
  expect(await db.rows("SELECT * FROM ledger_transactions")).toHaveLength(3);
  expect(await db.rows("SELECT * FROM payment_events WHERE kind='reconcilerCheck'")).toHaveLength(
    3,
  );
});

test("the typed payment API enforces scope and retries provider checkout creation through one receipt", async ({
  db,
}) => {
  const userId = await db.seedUser("agent");
  const accountId = await db.seedAccount();
  await db.rows("UPDATE accounts SET owner_id=$1 WHERE id=$2", [userId, accountId]);
  const actor: Actor = { userId, role: "agent", team: null };
  const adapter = sandboxProvider(db.store, env);
  let firstAttempt = true;
  const provider: PaymentProvider = {
    ...adapter,
    createCheckout: (input) => {
      if (firstAttempt) {
        firstAttempt = false;
        return Promise.reject(new Error("Provider unavailable"));
      }
      return adapter.createCheckout(input);
    },
  };
  const caller = appRouter.createCaller({
    store: db.store,
    principal: { kind: "development", actor },
    payments: { provider, firstCheckMs: 0 },
  });
  const input = {
    key: "retry",
    accountId,
    amount: "100",
    currency: "GBP",
    kind: "first" as const,
    mode: "drop" as const,
  };
  await expect(caller.payments.createCheckout(input)).rejects.toThrow("Provider unavailable");
  const created = await caller.payments.createCheckout(input);
  expect(await caller.payments.createCheckout(input)).toEqual(created);
  expect(await db.rows("SELECT * FROM payments")).toHaveLength(1);
  expect(await db.rows("SELECT * FROM sandbox_checkouts")).toHaveLength(1);
  const other = appRouter.createCaller({
    store: db.store,
    principal: {
      kind: "development",
      actor: { userId: await db.seedUser("agent"), role: "agent", team: null },
    },
  });
  await expect(other.payments.get({ id: created.paymentId })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(caller.accounts.ledger({ id: accountId })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(
    caller.payments.closeReview({ id: created.paymentId, reason: "Close" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect((await caller.payments.get({ id: created.paymentId })).posting).toBeNull();
});

test("a failed inbox write rolls settlement back and the signed retry succeeds", async ({ db }) => {
  const actor: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
  const { id } = await db.store.createPayment(
    actor,
    {
      key: "rollback",
      accountId: await db.seedAccount(),
      money: { minor: 100n, currency: "GBP" },
      kind: "first",
      mode: "normal",
    },
    0,
    "00000000-0000-4000-8000-000000000001",
  );
  const receiver = paymentWebhook(db.store, secret);
  const body = new TextEncoder().encode(
    JSON.stringify({
      eventId: "retry-after-failure",
      paymentId: id,
      status: "completed",
      amount: "100",
      currency: "GBP",
    }),
  );
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const request = () =>
    new Request("http://localhost/api/payments/webhook", {
      method: "POST",
      body,
      headers: {
        "x-sandbox-timestamp": timestamp,
        "x-sandbox-signature": signPaymentBody(secret, timestamp, body),
      },
    });
  await db.rows(
    "CREATE FUNCTION refuse_inbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test inbox failure'; END $$; CREATE TRIGGER refuse_inbox BEFORE INSERT ON webhook_inbox FOR EACH ROW EXECUTE FUNCTION refuse_inbox()",
  );
  expect((await receiver(request())).status).toBe(500);
  expect(await db.rows("SELECT * FROM webhook_inbox")).toHaveLength(0);
  expect(await db.rows("SELECT * FROM ledger_transactions")).toHaveLength(0);
  expect(await db.rows("SELECT * FROM outbox")).toHaveLength(0);
  expect((await db.store.getPayment(actor, id)).state.status).toBe("checkoutCreated");
  await db.rows("DROP TRIGGER refuse_inbox ON webhook_inbox");
  expect((await receiver(request())).status).toBe(200);
  expect(await db.rows("SELECT * FROM ledger_transactions")).toHaveLength(1);
  expect(await db.rows("SELECT * FROM outbox")).toHaveLength(1);
});

test("an expired checkout cannot be paid and an unknown checkout fails reconciliation", async ({
  db,
}) => {
  const actor: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
  const adapter = sandboxProvider(db.store, { ...env, checkoutTtlMs: 1 });
  const create = async (key: string) =>
    db.store.createPayment(
      actor,
      {
        key,
        accountId: await db.seedAccount(),
        money: { minor: 100n, currency: "GBP" },
        kind: "first",
        mode: "drop",
      },
      0,
      randomUUID(),
    );
  const expired = await create("expires");
  await adapter.createCheckout(await db.store.checkoutTerms(actor, expired.id));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(await db.store.paySandboxCheckout(expired.id)).toBeNull();
  expect(await adapter.readPayment(expired.id)).toMatchObject({ status: "expired" });
  const missing = await create("missing");
  await reconcilePayments(db.store, adapter, env.intervalMs);
  expect((await db.store.getPayment(actor, expired.id)).state.status).toBe("expired");
  expect((await db.store.getPayment(actor, missing.id)).state).toMatchObject({
    status: "failed",
    reason: "the checkout was never created at the provider",
  });
});

test("account editors close a waiting checkout with a reason and cancel the provider", async ({
  db,
}) => {
  const userId = await db.seedUser("agent");
  const accountId = await db.seedAccount();
  await db.rows("UPDATE accounts SET owner_id=$1 WHERE id=$2", [userId, accountId]);
  const actor: Actor = { userId, role: "agent", team: null };
  const provider = sandboxProvider(db.store, env);
  const caller = appRouter.createCaller({
    store: db.store,
    principal: { kind: "development", actor },
    payments: { provider, firstCheckMs: 0 },
  });
  const created = await caller.payments.createCheckout({
    key: "close",
    accountId,
    amount: "100",
    currency: "GBP",
    kind: "first",
  });
  await expect(
    caller.payments.closeCheckout({ id: created.paymentId, reason: " " }),
  ).rejects.toThrow();
  await caller.payments.closeCheckout({ id: created.paymentId, reason: "Customer stopped" });
  expect((await caller.payments.get({ id: created.paymentId })).state).toMatchObject({
    status: "failed",
    reason: "Customer stopped",
  });
  expect(await provider.readPayment(created.paymentId)).toMatchObject({ status: "failed" });
});
