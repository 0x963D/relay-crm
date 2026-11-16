import { expect, vi } from "vitest";

vi.setConfig({ testTimeout: 600_000 });
import { AccountId, UserId, PaymentId, parseExternalId } from "@relay/domain";
import { seedDemo, resetDemo, demoSchedule } from "../src/demo.ts";
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
  expect(
    await db.rows(
      "SELECT count(DISTINCT date_trunc('day',t.at))::int AS days FROM ledger_transactions t JOIN payments p ON p.id=t.payment_id JOIN leads l ON l.account_id=p.account_id WHERE l.name='Jonas Weber'",
    ),
  ).toEqual([{ days: 3 }]);
  const callbacks = await db.rows(
    "SELECT extract(hour FROM call_back_at AT TIME ZONE 'UTC')::int AS hour FROM leads WHERE name IN ('Hye-jin Park','Mateus Carvalho')",
  );
  expect(callbacks).toHaveLength(2);
  for (const row of callbacks) {
    expect(Number(row.hour)).toBeGreaterThanOrEqual(9);
    expect(Number(row.hour)).toBeLessThan(18);
  }

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
  const leases = await db.rows("SELECT * FROM job_leases ORDER BY route");
  const audit = await db.ownerRows("SELECT count(*)::int AS count FROM audit_log");
  expect(await seedDemo({ ...options(db), today: new Date("2033-02-01") })).toMatchObject({
    changed: false,
  });
  expect(await db.counts()).toEqual(before);
  expect(await db.rows("SELECT * FROM job_leases ORDER BY route")).toEqual(leases);
  expect(await db.ownerRows("SELECT count(*)::int AS count FROM audit_log")).toEqual(audit);
  await expect(db.rows("UPDATE demo_seed SET state='building'")).rejects.toMatchObject({
    code: "42501",
  });
});

test("reset requires demo mode and an owner marker, deletes visitor payments and ends sessions", async ({
  db,
}) => {
  await expect(resetDemo({ ...options(db), demo: true })).rejects.toThrow("not created");
  expect(await db.rows("SELECT * FROM job_leases")).toEqual([]);
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

test("a failed reseed rolls the wipe and seed marker back together", async ({ db }) => {
  await seedDemo(options(db));
  const before = await db.counts();
  const marker = await db.rows("SELECT * FROM demo_seed");
  await db.ownerRows(`CREATE FUNCTION refuse_demo_user() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'reseed refused'; END $$`);
  await db.ownerRows(`CREATE TRIGGER refuse_demo_user BEFORE INSERT ON users
    FOR EACH ROW EXECUTE FUNCTION refuse_demo_user()`);
  await expect(resetDemo({ ...options(db), demo: true })).rejects.toThrow("reseed refused");
  expect(await db.counts()).toEqual(before);
  expect(await db.rows("SELECT * FROM demo_seed")).toEqual(marker);
  expect(await db.store.demoReady()).toBe(true);
});

test("reset refuses a held payment lock without discarding the ready demo", async ({ db }) => {
  await seedDemo(options(db));
  const before = await db.counts();
  await db.gate.close("payments");
  try {
    await expect(resetDemo({ ...options(db), demo: true })).rejects.toThrow(/lock timeout/);
    expect(await db.counts()).toEqual(before);
    expect(await db.store.demoReady()).toBe(true);
  } finally {
    await db.gate.open();
  }
});

test("seeding also refuses intake history without a lead", async ({ db }) => {
  const externalId = parseExternalId("rejected-demo");
  if (!externalId) throw new Error("Invalid fixture");
  await db.store.intake({
    source: "csv",
    externalId,
    email: null,
    name: null,
    phone: null,
    attribution: { campaign: null, form: null, ad: null, adSet: null },
    submittedAt: null,
    receivedAt: today,
    raw: null,
  });
  await expect(seedDemo(options(db))).rejects.toThrow("empty database");
  expect(await db.rows("SELECT * FROM demo_seed")).toEqual([]);
});

test.for([
  ["Asia/Tokyo", "2031-07-14T15:00:00Z"],
  ["America/Los_Angeles", "2031-07-15T07:00:00Z"],
])(
  "demo queue keeps every group throughout the local day in %s",
  async ([timeZone, start], { db }) => {
    if (!timeZone || !start) throw new Error("Missing local day fixture");
    const midnight = new Date(start);
    await seedDemo({ ...options(db), today: midnight, timeZone });
    const userId = UserId.parse(DEMO_PEOPLE.agent.id);
    if (!userId) throw new Error("Missing agent");
    for (const minutes of [1, 720, 1439]) {
      const queue = await db.store.workQueue(
        { userId, role: "agent", team: null },
        {
          agentId: userId,
          at: new Date(midnight.getTime() + minutes * 60000),
          timeZone,
          limit: 100,
        },
      );
      expect(queue.counts).toEqual({
        overdueCallbacks: 2,
        dueToday: 2,
        noCallbackSet: 2,
        notYetCalled: 2,
        later: 2,
      });
    }
  },
);

test("demo people keep their final roles throughout seeded approvals", async ({ db }) => {
  await seedDemo(options(db));
  expect(
    await db.rows("SELECT role,role_version FROM users WHERE id=$1", [DEMO_PEOPLE.accountant.id]),
  ).toEqual([{ role: "accountant", role_version: 0 }]);
  expect(
    await db.rows(
      "SELECT count(*)::int AS count FROM payment_approvals a JOIN users u ON u.id=a.approver_id WHERE a.role_version<>u.role_version OR u.role NOT IN ('manager','accountant','admin','owner')",
    ),
  ).toEqual([{ count: 0 }]);
});

test.for(["Asia/Tokyo", "America/Los_Angeles"])(
  "demo history uses ordered working hours across a fortnight in %s",
  async (timeZone, { db }) => {
    await seedDemo({ ...options(db), timeZone });
    const times = await db.rows(
      `SELECT at FROM activities UNION ALL SELECT created_at AS at FROM leads UNION ALL SELECT created_at AS at FROM payments UNION ALL SELECT at FROM payment_approvals UNION ALL SELECT at FROM ledger_transactions UNION ALL SELECT started_at AS at FROM receipt_attempts`,
    );
    const dates = times.map((row) => new Date(String(row.at)));
    expect(new Set(dates.map((at) => at.toISOString().slice(0, 10))).size).toBeGreaterThanOrEqual(
      7,
    );
    for (const at of dates) {
      expect(at.getTime()).toBeGreaterThanOrEqual(today.getTime() - 15 * 86400000);
      expect(at.getTime()).toBeLessThan(today.getTime());
      const hour = Number(
        new Intl.DateTimeFormat("en", { timeZone, hour: "numeric", hourCycle: "h23" }).format(at),
      );
      expect(hour).toBeGreaterThanOrEqual(9);
      expect(hour).toBeLessThan(18);
    }
    expect(
      await db.rows(
        "SELECT count(*)::int AS count FROM activities a JOIN leads l ON l.id=a.lead_id WHERE a.at<l.created_at",
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await db.rows(
        "SELECT count(*)::int AS count FROM payments p JOIN accounts a ON a.id=p.account_id WHERE p.created_at<a.created_at OR p.decided_at<p.created_at",
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await db.rows(
        "SELECT count(*)::int AS count FROM payment_approvals a JOIN payments p ON p.id=a.payment_id WHERE a.at<p.created_at OR a.at>p.decided_at",
      ),
    ).toEqual([{ count: 0 }]);
  },
);

test("demo matches the funnel totals and keeps the board's named pool and accounts", async ({
  db,
}) => {
  await seedDemo(options(db));
  expect(await db.rows("SELECT count(*)::int AS count FROM leads WHERE status='new'")).toEqual([
    { count: 23 },
  ]);
  const userId = UserId.parse(DEMO_PEOPLE.manager.id);
  if (!userId) throw new Error("Missing manager");
  const funnel = await db.store.campaignFunnel({ userId, role: "manager", team: null });
  expect(
    funnel.rows.map(({ source, campaign, received, unassigned, contacted, won }) => ({
      source,
      campaign,
      received,
      unassigned,
      contacted,
      won,
    })),
  ).toEqual([
    {
      source: "metaLeadAds",
      campaign: "IELTS evening · January intake",
      received: 142,
      unassigned: 6,
      contacted: 97,
      won: 21,
    },
    {
      source: "metaLeadAds",
      campaign: "Business English · lunchtime online",
      received: 88,
      unassigned: 0,
      contacted: 61,
      won: 9,
    },
    {
      source: "metaLeadAds",
      campaign: "Spanish beginners · weekend",
      received: 76,
      unassigned: 4,
      contacted: 49,
      won: 13,
    },
    {
      source: "metaLeadAds",
      campaign: "German A1 · evening",
      received: 54,
      unassigned: 2,
      contacted: 31,
      won: 6,
    },
    {
      source: "metaLeadAds",
      campaign: "Summer school · early bird",
      received: 39,
      unassigned: 11,
      contacted: 12,
      won: 1,
    },
    {
      source: "webForm",
      campaign: "German A1 · evening",
      received: 8,
      unassigned: 0,
      contacted: 7,
      won: 3,
    },
    { source: "csv", campaign: null, received: 5, unassigned: 0, contacted: 4, won: 1 },
  ]);
  expect(await db.rows("SELECT count(*)::int AS count FROM accounts")).toEqual([{ count: 54 }]);
  expect(
    await db.rows(
      "SELECT name FROM leads WHERE status='new' AND name IN ('Luca Ferraro','Tunde Bakare','Emil Novak','Oskar Nowak') ORDER BY name",
    ),
  ).toHaveLength(4);
  expect(
    await db.rows("SELECT count(*)::int AS count FROM payments WHERE status='pendingApproval'"),
  ).toEqual([{ count: 4 }]);
  expect(
    await db.rows(
      "SELECT name,previous_owner_id FROM leads WHERE name IN ('Ravi Menon','Tunde Bakare') ORDER BY name",
    ),
  ).toEqual([
    { name: "Ravi Menon", previous_owner_id: "00000000-0000-7000-8000-000000000107" },
    { name: "Tunde Bakare", previous_owner_id: "00000000-0000-7000-8000-000000000106" },
  ]);
  for (const [person, count] of [
    ["00000000-0000-7000-8000-000000000105", 9],
    ["00000000-0000-7000-8000-000000000107", 12],
    ["00000000-0000-7000-8000-000000000106", 7],
  ] as const) {
    const agentId = UserId.parse(person);
    if (!agentId) throw new Error("Missing queue person");
    const queue = await db.store.workQueue(
      { userId, role: "manager", team: null },
      { agentId, at: today, timeZone: "UTC", limit: 100 },
    );
    expect(Object.values(queue.counts).reduce((sum, count) => sum + count, 0)).toBe(count);
  }
});

test("demo keeps an exhausted receipt failed and schedules a separate retry later today", async ({
  db,
}) => {
  await seedDemo(options(db));
  const failed = await db.rows(
    "SELECT payment_id,attempts,next_attempt_at FROM outbox WHERE state='failed' ORDER BY attempts DESC",
  );
  expect(failed).toHaveLength(2);
  expect(failed[0]).toMatchObject({ attempts: 12, next_attempt_at: null });
  expect(failed[1]).toMatchObject({ attempts: 1 });
  expect(new Date(String(failed[1]?.next_attempt_at)).getTime()).toBeGreaterThan(today.getTime());
  expect(
    await db.store.runOutbox(() => Promise.resolve({ state: "sent" }), {
      at: new Date(today.getTime() + 300000),
    }),
  ).toEqual([]);
  expect(await db.rows("SELECT count(*)::int AS count FROM outbox WHERE state='failed'")).toEqual([
    { count: 2 },
  ]);
});

test.for([
  ["Asia/Tokyo", "2031-07-14T15:01Z", "2031-07-14T15:00Z", "2031-07-15T15:00Z"],
  ["America/Los_Angeles", "2031-07-15T07:01Z", "2031-07-15T07:00Z", "2031-07-16T07:00Z"],
  ["America/New_York", "2026-03-08T05:01Z", "2026-03-08T05:00Z", "2026-03-09T04:00Z"],
  ["America/New_York", "2026-11-01T04:01Z", "2026-11-01T04:00Z", "2026-11-02T05:00Z"],
])(
  "reset scheduling uses the next local midnight in %s",
  async ([zone, at, start, next], { db }) => {
    if (!zone || !at || !start || !next) throw new Error("Missing schedule fixture");
    await db.ownerRows(
      "INSERT INTO demo_seed(key,company,state,seeded_at) VALUES ('tidewell-language-school/v1','Tidewell Language School','ready',$1)",
      [today],
    );
    expect(await demoSchedule(db.ownerConnectionString, zone, new Date(at))).toMatchObject({
      start: new Date(start),
      next: new Date(next),
    });
  },
);

test("startup restores an interrupted building marker with partial data", async ({ db }) => {
  const partial = await db.seedUser("manager");
  await db.ownerRows(
    "INSERT INTO demo_seed(key,company,state,seeded_at) VALUES ('tidewell-language-school/v1','Tidewell Language School','building',$1)",
    [today],
  );
  expect(await db.store.demoReady()).toBe(false);
  expect(await seedDemo(options(db))).toMatchObject({ changed: true });
  expect(await db.store.demoReady()).toBe(true);
  expect(await db.rows("SELECT id FROM users WHERE id=$1", [partial])).toEqual([]);
  expect(await db.rows("SELECT count(*)::int AS count FROM leads")).toEqual([{ count: 412 }]);
});
