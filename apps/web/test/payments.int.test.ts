import { createReceiptMailer } from "../src/server/mailer.ts";
import { openSmtpInbox } from "./support/smtp.ts";
import { createHash, randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import { test } from "@relay/store/testing";
import { type Actor, type PaymentProvider } from "@relay/domain";
import { paymentWebhook, signPaymentBody } from "../src/server/payments/webhook.ts";
import { reconcilePayments } from "../src/server/payments/reconcile.ts";
import { sandboxCheckout, sandboxProvider } from "../src/server/payments/sandbox.ts";
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
  ).toBe(409);
  const malformed = new TextEncoder().encode("{broken");
  expect(
    (await receiver(request(timestamp, signPaymentBody(secret, timestamp, malformed), malformed)))
      .status,
  ).toBe(400);
  const missing = new TextEncoder().encode(
    JSON.stringify({ ...payload, eventId: "missing", paymentId: randomUUID() }),
  );
  expect(
    (await receiver(request(timestamp, signPaymentBody(secret, timestamp, missing), missing)))
      .status,
  ).toBe(400);
  expect(await db.rows("SELECT * FROM webhook_inbox")).toHaveLength(1);
  expect((await receiver(request(timestamp, "0".repeat(64), new Uint8Array(100001)))).status).toBe(
    413,
  );
});

test("two reconcilers scanning the same candidates read each provider payment once", async ({
  db,
}) => {
  const actor: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
  const adapter = sandboxProvider(db.store, env);
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const { id } = await db.store.createPayment(
      actor,
      {
        key: String(i),
        accountId: await db.seedAccount(),
        money: { minor: 100n, currency: "GBP" },
        kind: "repeat",
        mode: "drop",
      },
      0,
      "00000000-0000-4000-8000-000000000001",
    );
    const checkout = await adapter.createCheckout(await db.store.checkoutTerms(actor, id));
    const token = checkout.url?.split("/").at(-1);
    if (!token) throw new Error("Missing token");
    await db.store.paySandboxCheckout(token);
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
  expect(await caller.payments.createCheckout(input)).toEqual({
    paymentId: created.paymentId,
    demo: false,
    checkout: { id: created.checkout.id, url: null },
  });
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
  await db.ownerRows(
    "CREATE FUNCTION refuse_inbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test inbox failure'; END $$; CREATE TRIGGER refuse_inbox BEFORE INSERT ON webhook_inbox FOR EACH ROW EXECUTE FUNCTION refuse_inbox()",
  );
  expect((await receiver(request())).status).toBe(500);
  expect(await db.rows("SELECT * FROM webhook_inbox")).toHaveLength(0);
  expect(await db.rows("SELECT * FROM ledger_transactions")).toHaveLength(0);
  expect(await db.rows("SELECT * FROM outbox")).toHaveLength(0);
  expect((await db.store.getPayment(actor, id)).state.status).toBe("checkoutCreated");
  await db.ownerRows("DROP TRIGGER refuse_inbox ON webhook_inbox");
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
  const expiring = await adapter.createCheckout(await db.store.checkoutTerms(actor, expired.id));
  const token = expiring.url?.split("/").at(-1);
  if (!token) throw new Error("Missing token");
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(await db.store.paySandboxCheckout(token)).toBeNull();
  expect(await adapter.readPayment(expired.id)).toMatchObject({ status: "expired" });
  const missing = await create("missing");
  await db.store.finishCheckoutCreation(missing.id);
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

test("a scan timestamp does not become the deadline origin for later claims", async ({ db }) => {
  const actor: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
  const { id } = await db.store.createPayment(
    actor,
    {
      key: "old-scan",
      accountId: await db.seedAccount(),
      money: { minor: 100n, currency: "GBP" },
      kind: "first",
      mode: "drop",
    },
    0,
    randomUUID(),
  );
  await db.store.finishCheckoutCreation(id);
  const scan = new Date();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const before = Date.now();
  await reconcilePayments(db.store, sandboxProvider(db.store, env), env.intervalMs, scan);
  const [row] = await db.rows("SELECT next_check_at FROM payments WHERE id=$1", [id]);
  if (!(row?.next_check_at instanceof Date)) throw new Error("No deadline");
  expect(row.next_check_at.getTime()).toBeGreaterThanOrEqual(before + env.intervalMs);
});

test("signed malformed JSON is refused as input", async ({ db }) => {
  const body = new TextEncoder().encode("{broken");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const response = await paymentWebhook(
    db.store,
    secret,
  )(
    new Request("http://localhost/api/payments/webhook", {
      method: "POST",
      body,
      headers: {
        "x-sandbox-timestamp": timestamp,
        "x-sandbox-signature": signPaymentBody(secret, timestamp, body),
      },
    }),
  );
  expect(response.status).toBe(400);
});

test("payment readers cannot obtain or use the sandbox pay capability", async ({ db }) => {
  const actor: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
  const accountId = await db.seedAccount();
  const provider = sandboxProvider(db.store, env);
  const caller = appRouter.createCaller({
    store: db.store,
    principal: { kind: "development", actor },
    payments: { provider, firstCheckMs: 0 },
  });
  const created = await caller.payments.createCheckout({
    key: "capability",
    accountId,
    amount: "100",
    currency: "GBP",
    kind: "first",
    mode: "drop",
  });
  const accountant: Actor = {
    userId: await db.seedUser("accountant"),
    role: "accountant",
    team: null,
  };
  const reader = appRouter.createCaller({
    store: db.store,
    principal: { kind: "development", actor: accountant },
    payments: { provider, firstCheckMs: 0 },
  });
  const view = await reader.payments.get({ id: created.paymentId });
  const page = sandboxCheckout(db.store, env, () => {
    throw new Error("Drop mode delivers nothing");
  });
  expect(
    (
      await page(
        new Request(`${env.baseUrl}/sandbox/checkout/${view.id}`, {
          method: "POST",
          headers: { origin: env.baseUrl },
        }),
        view.id,
      )
    ).status,
  ).toBe(404);
  expect(view).not.toHaveProperty("checkoutPath");
  if (!created.checkout.url) throw new Error("Missing new pay link");
  const token = new URL(created.checkout.url).pathname.split("/").at(-1);
  if (!token) throw new Error("Missing token");
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(created.checkout.id).not.toBe(created.paymentId);
  expect(
    await db.rows("SELECT token_hash FROM sandbox_checkouts WHERE payment_id=$1", [
      created.paymentId,
    ]),
  ).toEqual([{ token_hash: createHash("sha256").update(token).digest("hex") }]);
  const text = JSON.stringify(view, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  expect(text).not.toContain(token);
  expect(text).not.toContain("tokenHash");
  expect(
    (
      await page(
        new Request(created.checkout.url, { method: "POST", headers: { origin: env.baseUrl } }),
        token,
      )
    ).status,
  ).toBe(303);
  await reconcilePayments(db.store, provider, env.intervalMs);
  expect((await reader.payments.get({ id: created.paymentId })).state.status).toBe("completed");
  await expect(
    reader.payments.createCheckout({
      key: "denied",
      accountId,
      amount: "100",
      currency: "GBP",
      kind: "first",
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("payment API responses identify a demo deployment", async ({ db }) => {
  const actor: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
  const caller = appRouter.createCaller({
    store: db.store,
    principal: { kind: "development", actor },
    demo: true,
    payments: { provider: sandboxProvider(db.store, env), firstCheckMs: 0 },
  });
  const accountId = await db.seedAccount();
  const created = await caller.payments.createCheckout({
    key: "demo",
    accountId,
    amount: "100",
    currency: "GBP",
    kind: "first",
  });
  expect(created).toMatchObject({ demo: true });
  expect(await caller.payments.get({ id: created.paymentId })).toMatchObject({ demo: true });
  expect(await caller.payments.list({ limit: 10 })).toMatchObject({ demo: true });
  expect(
    await caller.payments.closeCheckout({ id: created.paymentId, reason: "Demo close" }),
  ).toMatchObject({ demo: true });
  expect(await caller.accounts.ledger({ id: accountId })).toMatchObject({ demo: true });
});

test("worker HTTP responses contain counts without record identifiers", async ({ db }) => {
  const values = {
    DATABASE_URL: db.connectionString,
    NODE_ENV: "production",
    RELAY_DEMO: "1",
    RELAY_SANDBOX: "1",
    RELAY_SANDBOX_URL: env.baseUrl,
    RELAY_PAYMENT_WEBHOOK_SECRET: env.webhookSecret,
    RELAY_RECONCILE_SECRET: env.reconcileSecret,
    RELAY_OUTBOX_SECRET: "fake-outbox-secret-for-local-tests-only",
    AUTH_SECRET: "fake-authentication-secret-for-local-tests-only",
    AUTH_URL: env.baseUrl,
    SMTP_URL: "smtp://127.0.0.1:9",
    SMTP_FROM: "test@sender.example",
  };
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  const actor: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
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
  const paid = await create("receipt");
  await db.store.receivePaymentWebhook({
    eventId: randomUUID(),
    paymentId: paid.id,
    payloadHash: "ab".repeat(32),
    observed: { status: "completed", money: { minor: 100n, currency: "GBP" } },
  });
  await db.store.finishCheckoutCreation((await create("missing")).id);
  try {
    const { POST: reconcile } = await import("../src/app/api/payments/reconcile/route.ts");
    const { POST: outbox } = await import("../src/app/api/payments/outbox/route.ts");
    const request = (secret: string) =>
      new Request(`${env.baseUrl}/api/payments/reconcile`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}` },
      });
    const checked = await reconcile(request(env.reconcileSecret));
    expect(checked.status).toBe(200);
    expect.soft(await checked.json()).toEqual({ checked: 1, changed: 1 });
    const delivered = await outbox(request(values.RELAY_OUTBOX_SECRET));
    expect(delivered.status).toBe(200);
    expect.soft(await delivered.json()).toEqual({
      processed: 1,
      sent: 0,
      failed: 0,
      suppressed: 1,
      unknown: 0,
      recordingFailed: 0,
      superseded: 0,
    });
  } finally {
    await globalThis.relayComposition?.store.close();
    Reflect.deleteProperty(globalThis, "relayComposition");
    vi.unstubAllEnvs();
  }
});

test("a worker deadline before the SMTP greeting records a retryable failure", async ({ db }) => {
  const actor: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
  const accountId = await db.seedAccount();
  const money = { minor: 100n, currency: "GBP" as const };
  const { id } = await db.store.createPayment(
    actor,
    { key: randomUUID(), accountId, money, kind: "first", mode: "drop" },
    0,
    randomUUID(),
  );
  await db.store.receivePaymentWebhook({
    eventId: randomUUID(),
    paymentId: id,
    payloadHash: "fake",
    observed: { status: "completed", money },
  });
  await db.rows("UPDATE outbox SET recipient='receipt@example.com' WHERE payment_id=$1", [id]);
  const inbox = await openSmtpInbox(() => "sent", "greeting");
  try {
    const send = createReceiptMailer({ kind: "smtp", url: inbox.url, from: "sender@example.com" });
    expect(await db.store.runOutbox(send, { leaseMs: 2000, sendTimeoutMs: 200 })).toMatchObject([
      { state: "failed" },
    ]);
    expect((await db.store.getPayment(actor, id)).receipt?.nextAttemptAt).toBeInstanceOf(Date);
  } finally {
    await inbox.close();
  }
});

test("closing an already paid checkout returns review and an explanation in the same request", async ({
  db,
}) => {
  const actor: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
  const caller = appRouter.createCaller({
    store: db.store,
    principal: { kind: "development", actor },
    payments: { provider: sandboxProvider(db.store, env), firstCheckMs: 0 },
  });
  const created = await caller.payments.createCheckout({
    key: "paid-close",
    accountId: await db.seedAccount(),
    amount: "100",
    currency: "GBP",
    kind: "first",
    mode: "drop",
  });
  const token = created.checkout.url?.split("/").at(-1);
  if (!token) throw new Error("No token");
  await db.store.paySandboxCheckout(token);
  const closed = await caller.payments.closeCheckout({
    id: created.paymentId,
    reason: "Customer says unpaid",
  });
  expect(closed.state).toMatchObject({ status: "needsReview", reason: "paid after close" });
  expect(closed).toMatchObject({
    message: "The checkout was already paid. The payment needs review; nothing was credited.",
  });
  expect(await db.rows("SELECT * FROM ledger_transactions")).toHaveLength(0);
});

test("a signed report for a manual payment is refused without recording an inbox or posting", async ({
  db,
}) => {
  const actor: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
  const { id } = await db.store.recordManualPayment(
    actor,
    {
      key: "manual-webhook",
      accountId: await db.seedAccount(),
      money: { minor: 100n, currency: "GBP" },
      kind: "first",
      receiptHash: "b".repeat(64),
      reference: null,
    },
    randomUUID(),
  );
  const body = new TextEncoder().encode(
    JSON.stringify({
      eventId: "fake-manual-report",
      paymentId: id,
      status: "completed",
      amount: "100",
      currency: "GBP",
    }),
  );
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const response = await paymentWebhook(
    db.store,
    secret,
  )(
    new Request("http://localhost/api/payments/webhook", {
      method: "POST",
      body,
      headers: {
        "x-sandbox-timestamp": timestamp,
        "x-sandbox-signature": signPaymentBody(secret, timestamp, body),
      },
    }),
  );
  expect(response.status).toBe(400);
  expect(await db.rows("SELECT * FROM webhook_inbox")).toHaveLength(0);
  expect(await db.rows("SELECT * FROM payment_events WHERE kind='webhookDelivery'")).toHaveLength(
    0,
  );
  expect(await db.rows("SELECT * FROM ledger_transactions")).toHaveLength(0);
});
