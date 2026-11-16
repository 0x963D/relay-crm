import { expect } from "vitest";
import { AccountId, UserId, PaymentId } from "@relay/domain";
import { seedDemo, resetDemo } from "../src/demo.ts";
import { DEMO_PEOPLE } from "../src/demo-state.ts";
import { test, type TestDatabase } from "../src/testing/index.ts";

const today = new Date("2031-07-15T23:30:00Z");
const options = (db: TestDatabase) => ({
  ownerUrl: db.ownerConnectionString,
  appUrl: db.connectionString,
  today,
  deliver: () => Promise.resolve({ state: "sent" as const }),
});

test("the operation-built demo covers the board, balances its postings and seeds only once", async ({
  db,
}) => {
  expect(await db.store.databaseReady()).toBe(true);
  expect(await seedDemo(options(db))).toMatchObject({ changed: true });
  const principal = await db.store.demoPerson("agent");
  const userId = UserId.parse(principal.id);
  if (!userId) throw new Error("No demo agent");
  const queue = await db.store.workQueue(
    { userId, role: "agent", team: null },
    { agentId: userId, at: today, timeZone: "UTC", limit: 100 },
  );
  for (const key of [
    "overdueCallbacks",
    "dueToday",
    "noCallbackSet",
    "notYetCalled",
    "later",
  ] as const)
    expect(queue[key]).toHaveLength(2);
  expect(
    await db.rows("SELECT DISTINCT status,reason FROM payments ORDER BY status,reason"),
  ).toEqual([
    { status: "checkoutCreated", reason: null },
    { status: "completed", reason: null },
    { status: "expired", reason: null },
    { status: "needsReview", reason: "amount mismatch" },
    { status: "needsReview", reason: "paid after close" },
    { status: "pendingApproval", reason: null },
    { status: "rejected", reason: "The invented receipt does not match the bank transfer." },
  ]);
  expect(await db.rows("SELECT DISTINCT state FROM outbox ORDER BY state")).toEqual([
    { state: "failed" },
    { state: "sent" },
    { state: "suppressed" },
    { state: "unknown" },
  ]);
  const [account] = await db.rows("SELECT account_id FROM leads WHERE name='Jonas Weber'");
  const accountId = AccountId.parse(String(account?.account_id));
  if (!accountId) throw new Error("No Jonas account");
  const managerId = UserId.parse(DEMO_PEOPLE.manager.id);
  if (!managerId) throw new Error("No manager");
  const ledger = await db.store.accountLedger(
    { userId: managerId, role: "manager", team: null },
    accountId,
  );
  expect(ledger.balances[0]?.balance).toBe(118500n);
  expect(ledger.balances[0]?.entries).toHaveLength(3);
  for (const entry of ledger.balances.flatMap((balance) => balance.entries)) {
    const lines = entry.posting?.lines ?? [];
    expect(
      lines.filter((line) => line.side === "debit").reduce((sum, line) => sum + line.amount, 0n),
    ).toBe(
      lines.filter((line) => line.side === "credit").reduce((sum, line) => sum + line.amount, 0n),
    );
  }
  expect(
    await db.rows(
      "SELECT count(*)::int AS count FROM payment_events WHERE kind='webhookDelivery' AND detail->>'duplicate'='true'",
    ),
  ).toEqual([{ count: 1 }]);
  expect(
    await db.rows("SELECT count(*)::int AS count FROM payments WHERE completed_by='reconciler'"),
  ).toEqual([{ count: 1 }]);
  const before = await db.counts();
  const audit = await db.ownerRows("SELECT count(*)::int AS count FROM audit_log");
  expect(await seedDemo({ ...options(db), today: new Date("2033-02-01") })).toMatchObject({
    changed: false,
  });
  expect(await db.counts()).toEqual(before);
  expect(await db.ownerRows("SELECT count(*)::int AS count FROM audit_log")).toEqual(audit);
  await expect(db.rows("UPDATE demo_seed SET state='building'")).rejects.toMatchObject({
    code: "42501",
  });
});

test("reset requires demo mode and an owner marker, deletes visitor payments and ends sessions", async ({
  db,
}) => {
  await expect(resetDemo({ ...options(db), demo: true })).rejects.toThrow("not created");
  await seedDemo(options(db));
  await expect(async () => resetDemo({ ...options(db), demo: false })).rejects.toThrow(
    "RELAY_DEMO=1",
  );
  await db.rows(
    "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES(gen_random_uuid(),$1,'fake-demo-token',now()+interval '1 hour')",
    [DEMO_PEOPLE.agent.id],
  );
  const person = await db.store.demoPerson("manager");
  const userId = UserId.parse(person.id);
  const [row] = await db.rows("SELECT account_id FROM leads WHERE name='Jonas Weber'");
  const accountId = AccountId.parse(String(row?.account_id));
  if (!userId || !accountId) throw new Error("Missing fixture");
  const payment = await db.store.createPayment(
    { userId, role: "manager", team: null },
    {
      accountId,
      key: "visitor-payment",
      money: { minor: 100n, currency: "GBP" },
      kind: "repeat",
      mode: "drop",
    },
    0,
    crypto.randomUUID(),
  );
  const paymentId = PaymentId.parse(payment.id);
  if (!paymentId) throw new Error("Invalid payment");
  await resetDemo({ ...options(db), demo: true });
  expect(await db.rows("SELECT id FROM payments WHERE id=$1", [paymentId])).toEqual([]);
  expect(await db.rows("SELECT id FROM auth_sessions")).toEqual([]);
  expect(await db.store.demoReady()).toBe(true);
  await expect(db.rows("TRUNCATE ledger_lines")).rejects.toMatchObject({ code: "42501" });
  await expect(db.ownerRows("TRUNCATE ledger_lines")).rejects.toMatchObject({ code: "23001" });
});

test("seeding refuses an unmarked database that already has people", async ({ db }) => {
  await db.seedUser("manager");
  await expect(seedDemo(options(db))).rejects.toThrow("empty database");
  expect(await db.rows("SELECT * FROM demo_seed")).toEqual([]);
});
