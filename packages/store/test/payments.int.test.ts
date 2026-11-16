import { createHash, randomUUID } from "node:crypto";
import { expect } from "vitest";
import { type Actor, type ProviderPayment } from "@relay/domain";
import { test, type TestDatabase } from "../src/testing/index.ts";

const money = { minor: 39500n, currency: "GBP" } as const;
const observed: ProviderPayment = { status: "completed", money };
async function setup(db: TestDatabase) {
  const userId = await db.seedUser("agent");
  const managerId = await db.seedUser("manager");
  const accountId = await db.seedAccount();
  await db.rows("UPDATE accounts SET owner_id=$1 WHERE id=$2", [userId, accountId]);
  const actor: Actor = { userId, role: "agent", team: null };
  const manager: Actor = { userId: managerId, role: "manager", team: null };
  const created = await db.store.createPayment(
    actor,
    { key: randomUUID(), accountId, money, kind: "repeat", mode: "drop" },
    0,
    "00000000-0000-4000-8000-000000000001",
  );
  const event = {
    eventId: randomUUID(),
    paymentId: created.id,
    payloadHash: createHash("sha256").update(created.id).digest("hex"),
    observed,
  };
  return { actor, manager, accountId, id: created.id, event };
}
async function counts(db: TestDatabase) {
  return db.rows(`SELECT (SELECT count(*)::int FROM ledger_transactions) AS postings,
    (SELECT count(*)::int FROM ledger_lines) AS lines, (SELECT coalesce(sum(amount),0)::text FROM ledger_lines) AS total,
    (SELECT count(*)::int FROM outbox) AS outbox`);
}

test("a webhook, its duplicate and the reconciler collide and credit exactly once", async ({
  db,
}) => {
  const { id, event, manager, accountId } = await setup(db);
  const token = await db.store.claimPaymentCheck(id, new Date(), 300000);
  if (!token) throw new Error("The due payment was not claimed");
  await db.gate.close("payments");
  const racers = [
    db.store.receivePaymentWebhook(event),
    db.store.receivePaymentWebhook(event),
    db.store.finishPaymentCheck(id, token, observed),
  ];
  try {
    await db.gate.waitForWaiters(3);
  } finally {
    await db.gate.open();
  }
  const results = await Promise.all(racers);
  expect(results.filter((r) => r.changed)).toHaveLength(1);
  expect(await counts(db)).toEqual([{ postings: 1, lines: 2, total: "0", outbox: 1 }]);
  expect(db.transactions.some((t) => t.attempts > 1)).toBe(true);
  const detail = await db.store.getPayment(manager, id);
  expect(detail.events.filter((e) => e.kind === "webhookDelivery")).toHaveLength(2);
  expect(detail.events.filter((e) => e.kind === "reconcilerCheck")).toHaveLength(1);
  expect(detail.events.filter((e) => e.kind === "settlement")).toHaveLength(1);
  expect((await db.store.accountLedger(manager, accountId)).balances[0]?.balance).toBe(39500n);
});

test("a lost webhook is reconciled and a late webhook changes no money or audit", async ({
  db,
}) => {
  const { id, event } = await setup(db);
  const token = await db.store.claimPaymentCheck(id, new Date(), 300000);
  if (!token) throw new Error("No claim");
  await db.store.finishPaymentCheck(id, token, observed);
  const audit = await db.rows("SELECT * FROM audit_log ORDER BY id");
  expect(await db.store.receivePaymentWebhook(event)).toEqual({
    status: "completed",
    changed: false,
    duplicate: false,
  });
  expect(await db.rows("SELECT * FROM audit_log ORDER BY id")).toEqual(audit);
  expect(await counts(db)).toEqual([{ postings: 1, lines: 2, total: "0", outbox: 1 }]);
  expect(
    await db.rows(
      "SELECT detail->>'late' AS late FROM payment_events WHERE kind='webhookDelivery'",
    ),
  ).toEqual([{ late: "true" }]);
});

test.for([
  { minor: 39501n, currency: "GBP" },
  { minor: 39500n, currency: "EUR" },
] as const)("a mismatch %# credits nothing and cannot later complete", async (reported, { db }) => {
  const { id, event, manager, actor } = await setup(db);
  await db.store.receivePaymentWebhook({
    ...event,
    observed: { status: "completed", money: reported },
  });
  expect((await db.store.getPayment(manager, id)).state).toMatchObject({
    status: "needsReview",
    reported,
  });
  await db.store.receivePaymentWebhook({ ...event, eventId: randomUUID() });
  expect((await db.store.getPayment(manager, id)).state.status).toBe("needsReview");
  await expect(
    db.store.closePaymentReview(
      actor,
      id,
      "Amount differed",
      "00000000-0000-4000-8000-000000000001",
    ),
  ).rejects.toMatchObject({
    code: "accessDenied",
  });
  await expect(
    db.store.closePaymentReview(manager, id, " ", "00000000-0000-4000-8000-000000000001"),
  ).rejects.toMatchObject({
    code: "conflict",
  });
  await db.store.closePaymentReview(
    manager,
    id,
    "Provider disagreed with the checkout.",
    "00000000-0000-4000-8000-000000000001",
  );
  await db.store.receivePaymentWebhook({ ...event, eventId: randomUUID() });
  expect((await db.store.getPayment(manager, id)).state.status).toBe("needsReview");
  expect(await counts(db)).toEqual([{ postings: 0, lines: 0, total: "0", outbox: 0 }]);
  const audits = await db.rows("SELECT before FROM audit_log WHERE action='paymentReviewClosed'");
  expect(audits[0]?.before).toMatchObject({
    reportedAmount: reported.minor.toString(),
    reportedCurrency: reported.currency,
  });
});

test("scope hides other accounts and all ledger lines from agents", async ({ db }) => {
  const { id, event, actor, accountId } = await setup(db);
  const other: Actor = { userId: await db.seedUser("agent"), role: "agent", team: null };
  await db.store.receivePaymentWebhook(event);
  await expect(db.store.getPayment(other, id)).rejects.toMatchObject({ code: "accessDenied" });
  expect(await db.store.listPayments(other, 100)).toEqual({
    waitingForApproval: [],
    waitingForProvider: [],
    needsReview: [],
    decidedThisWeek: [],
  });
  expect((await db.store.getPayment(actor, id)).posting).toBeNull();
  await expect(db.store.accountLedger(actor, accountId)).rejects.toMatchObject({
    code: "accessDenied",
  });
  await expect(
    db.store.createPayment(
      other,
      { key: "foreign", accountId, money, kind: "first", mode: "normal" },
      0,
      "00000000-0000-4000-8000-000000000001",
    ),
  ).rejects.toMatchObject({ code: "accessDenied" });
});

test("checkout request receipts replay and refuse changed input", async ({ db }) => {
  const { actor, accountId } = await setup(db);
  const input = { key: "checkout", accountId, money, kind: "first", mode: "normal" } as const;
  const first = await db.store.createPayment(
    actor,
    input,
    0,
    "00000000-0000-4000-8000-000000000001",
  );
  expect(
    await db.store.createPayment(actor, input, 0, "00000000-0000-4000-8000-000000000001"),
  ).toEqual(first);
  await expect(
    db.store.createPayment(
      actor,
      { ...input, money: { ...money, minor: 1n } },
      0,
      "00000000-0000-4000-8000-000000000001",
    ),
  ).rejects.toMatchObject({ code: "idempotencyConflict" });
});

test("the database refuses second postings, unbalanced postings and ledger mutations", async ({
  db,
}) => {
  const { id, event, actor, accountId } = await setup(db);
  await db.store.receivePaymentWebhook(event);
  await expect(
    db.rows("INSERT INTO ledger_transactions(id,payment_id,at) VALUES ($1,$2,now())", [
      randomUUID(),
      id,
    ]),
  ).rejects.toMatchObject({ code: "23505", constraint: "ledger_transactions_payment_id_key" });
  for (const sql of [
    "UPDATE ledger_lines SET amount=amount+1",
    "DELETE FROM ledger_lines",
    "UPDATE ledger_transactions SET at=now()",
    "DELETE FROM ledger_transactions",
    "UPDATE ledger_accounts SET currency='USD'",
  ]) {
    await expect(db.rows(sql)).rejects.toMatchObject({ code: "23001" });
  }
  const { id: second } = await db.store.createPayment(
    actor,
    { key: "second", accountId, money, kind: "repeat", mode: "drop" },
    0,
    "00000000-0000-4000-8000-000000000001",
  );
  const transaction = randomUUID();
  await db.rows("BEGIN");
  try {
    await db.rows(
      "UPDATE payments SET status='completed',completed_by='reconciler',decided_at=now() WHERE id=$1",
      [second],
    );
    await db.rows("INSERT INTO ledger_transactions(id,payment_id,at) VALUES ($1,$2,now())", [
      transaction,
      second,
    ]);
    await db.rows(
      "INSERT INTO ledger_lines(id,transaction_id,ledger_account_id,amount) SELECT gen_random_uuid(),$1,id,CASE WHEN kind='customer' THEN 39500 ELSE -39499 END FROM ledger_accounts",
      [transaction],
    );
    await expect(db.rows("COMMIT")).rejects.toMatchObject({
      code: "23514",
      constraint: "ledger_posting_balanced",
    });
  } finally {
    await db.rows("ROLLBACK");
  }
  await expect(
    db.rows(
      "UPDATE payments SET status='completed',completed_by='reconciler',decided_at=now() WHERE id=$1",
      [second],
    ),
  ).rejects.toMatchObject({ code: "23514", constraint: "payment_posting_required" });
  expect(await counts(db)).toEqual([{ postings: 1, lines: 2, total: "0", outbox: 1 }]);
});

test("concurrent claimers take each due payment once and release pending work at the next interval", async ({
  db,
}) => {
  const { id } = await setup(db);
  const now = new Date();
  const tokens = await Promise.all([
    db.store.claimPaymentCheck(id, now, 300000),
    db.store.claimPaymentCheck(id, now, 300000),
  ]);
  expect(tokens.filter(Boolean)).toHaveLength(1);
  expect(await db.store.duePayments(now, 100)).toEqual([]);
  const next = new Date(now.getTime() + 300000);
  expect(await db.store.duePayments(next, 100)).toEqual([{ id }]);
  expect(await db.store.claimPaymentCheck(id, next, 300000)).not.toBeNull();
});

test.for(["failed", "expired"] as const)(
  "records provider %s without a posting",
  async (status, { db }) => {
    const { event, id, manager } = await setup(db);
    await db.store.receivePaymentWebhook({ ...event, observed: { status, money } });
    expect((await db.store.getPayment(manager, id)).state.status).toBe(status);
    expect(await counts(db)).toEqual([{ postings: 0, lines: 0, total: "0", outbox: 0 }]);
  },
);

test.for(["failed", "expired"] as const)(
  "a paid report after %s is reviewed without credit",
  async (status, { db }) => {
    const { id, event, manager } = await setup(db);
    await db.store.receivePaymentWebhook({ ...event, observed: { status, money } });
    await db.store.receivePaymentWebhook({ ...event, eventId: randomUUID() });
    expect((await db.store.getPayment(manager, id)).state).toMatchObject({
      status: "needsReview",
      reason: "paid after close",
      reported: money,
    });
    expect(await counts(db)).toEqual([{ postings: 0, lines: 0, total: "0", outbox: 0 }]);
    await db.store.closePaymentReview(manager, id, "Returned outside the app", randomUUID());
    expect((await db.store.getPayment(manager, id)).state).toMatchObject({
      status: "failed",
      reason: "Returned outside the app",
    });
  },
);

test.for(["webhook", "reconciler"] as const)(
  "%s observation precedes its settlement",
  async (source, { db }) => {
    const { id, event, manager } = await setup(db);
    if (source === "webhook") await db.store.receivePaymentWebhook(event);
    else {
      const token = await db.store.claimPaymentCheck(id, new Date(), 300000);
      if (!token) throw new Error("No claim");
      await db.store.finishPaymentCheck(id, token, observed);
    }
    expect((await db.store.getPayment(manager, id)).events.map((e) => e.kind)).toEqual([
      "checkoutCreated",
      source === "webhook" ? "webhookDelivery" : "reconcilerCheck",
      "settlement",
    ]);
  },
);

test("a superseded check retains the provider answer without settling", async ({ db }) => {
  const { id, manager } = await setup(db);
  const at = new Date();
  const stale = await db.store.claimPaymentCheck(id, at, 1000);
  const fresh = await db.store.claimPaymentCheck(id, new Date(at.getTime() + 1001), 1000);
  if (!stale || !fresh) throw new Error("No claims");
  expect(await db.store.finishPaymentCheck(id, stale, observed)).toEqual({
    status: "checkoutCreated",
    changed: false,
  });
  const checks = (await db.store.getPayment(manager, id)).events.filter(
    (e) => e.kind === "reconcilerCheck",
  );
  expect(checks).toHaveLength(1);
  expect(checks[0]?.detail).toMatchObject({
    superseded: true,
    checkId: stale,
    providerStatus: "completed",
    reportedAmount: "39500",
    changed: false,
  });
  expect(await counts(db)).toEqual([{ postings: 0, lines: 0, total: "0", outbox: 0 }]);
});
