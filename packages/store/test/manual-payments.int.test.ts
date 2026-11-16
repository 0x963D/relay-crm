import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { Actor, Money, Role } from "@relay/domain";
import { test, type TestDatabase } from "../src/testing/index.ts";

const requestId = "00000000-0000-4000-8000-000000000001";
const money: Money = { minor: 48000n, currency: "GBP" };
async function setup(db: TestDatabase) {
  const person = async (role: Role): Promise<Actor> => ({
    userId: await db.seedUser(role),
    role,
    team: null,
  });
  const recorder = await person("manager"),
    a = await person("accountant"),
    b = await person("manager"),
    c = await person("owner");
  const accountId = await db.seedAccount();
  const terms = {
    accountId,
    key: randomUUID(),
    money,
    kind: "first" as const,
    receiptHash: "a".repeat(64),
    reference: "Transfer reference",
  };
  const { id } = await db.store.recordManualPayment(recorder, terms, requestId);
  return { recorder, a, b, c, accountId, terms, id, input: { id, version: 0, roleVersion: 0 } };
}
async function collision(db: TestDatabase, calls: () => Promise<unknown>[]) {
  await db.gate.close("payments");
  const results = Promise.allSettled(calls());
  try {
    await db.gate.waitForWaiters(2);
  } finally {
    await db.gate.open();
  }
  return results;
}
async function counts(db: TestDatabase) {
  return db.rows(`SELECT (SELECT count(*)::int FROM ledger_transactions) AS postings,
    (SELECT count(*)::int FROM ledger_lines) AS lines, (SELECT coalesce(sum(amount),0)::text FROM ledger_lines) AS total,
    (SELECT count(*)::int FROM outbox) AS outbox`);
}
test("two different approvals collide and credit exactly once", async ({ db }) => {
  const w = await setup(db);
  expect(await counts(db)).toEqual([{ postings: 0, lines: 0, total: "0", outbox: 0 }]);
  const results = await collision(db, () => [
    db.store.approveManualPayment(w.a, w.input, requestId),
    db.store.approveManualPayment(w.b, w.input, requestId),
  ]);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(await counts(db)).toEqual([{ postings: 1, lines: 2, total: "0", outbox: 1 }]);
  const detail = await db.store.getPayment(w.a, w.id);
  expect(detail.state).toMatchObject({ status: "completed", by: "manualApproval" });
  expect(detail.approvals).toHaveLength(2);
  expect(detail.posting?.lines.map((l) => l.account.name)).toContain("Bank transfers and cash");
  expect((await db.store.accountLedger(w.a, w.accountId)).balances[0]?.balance).toBe(48000n);
  expect(await db.rows("SELECT DISTINCT request_id FROM audit_log")).toEqual([
    { request_id: requestId },
  ]);
  expect(db.transactions.some((t) => t.attempts > 1)).toBe(true);
});
test("the same approver racing records one approval", async ({ db }) => {
  const w = await setup(db);
  const results = await collision(db, () => [
    db.store.approveManualPayment(w.a, w.input, requestId),
    db.store.approveManualPayment(w.a, w.input, requestId),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { code: "alreadyApproved" },
  });
  expect((await db.store.getPayment(w.a, w.id)).approvals).toHaveLength(1);
  expect(await counts(db)).toEqual([{ postings: 0, lines: 0, total: "0", outbox: 0 }]);
});
test("the recorder cannot approve and role changes void pending approvals", async ({ db }) => {
  const w = await setup(db);
  await expect(db.store.approveManualPayment(w.recorder, w.input, requestId)).rejects.toMatchObject(
    { code: "paymentRecorder" },
  );
  await db.store.approveManualPayment(w.a, w.input, requestId);
  await db.rows("UPDATE users SET role='agent' WHERE id=$1", [w.a.userId]);
  expect(await db.rows("SELECT role_version FROM users WHERE id=$1", [w.a.userId])).toEqual([
    { role_version: 1 },
  ]);
  await expect(db.store.approveManualPayment(w.a, w.input, requestId)).rejects.toMatchObject({
    code: "roleChanged",
  });
  await db.store.approveManualPayment(w.b, w.input, requestId);
  const waiting = await db.store.getPayment(w.b, w.id);
  expect(waiting.state.status).toBe("pendingApproval");
  expect(waiting.approvals.filter((a) => a.voidedAt === null)).toHaveLength(1);
  expect(waiting.cannotApprove).toContainEqual(expect.objectContaining({ reason: "roleChanged" }));
  await db.store.approveManualPayment(w.c, w.input, requestId);
  expect((await db.store.getPayment(w.c, w.id)).state.status).toBe("completed");
  await db.rows("UPDATE users SET role='agent' WHERE id=$1", [w.b.userId]);
  expect(
    (await db.store.getPayment(w.c, w.id)).approvals.filter((a) => a.voidedAt === null),
  ).toHaveLength(2);
});
test("manual recording replays, and duplicate account and receipt failures say why", async ({
  db,
}) => {
  const w = await setup(db);
  expect(await db.store.recordManualPayment(w.recorder, w.terms, requestId)).toEqual({ id: w.id });
  await expect(
    db.store.recordManualPayment(
      w.recorder,
      { ...w.terms, key: randomUUID(), receiptHash: "b".repeat(64) },
      requestId,
    ),
  ).rejects.toMatchObject({ code: "pendingPayment" });
  const other = await db.seedAccount();
  await expect(
    db.store.recordManualPayment(
      w.recorder,
      { ...w.terms, key: randomUUID(), accountId: other },
      requestId,
    ),
  ).rejects.toMatchObject({ code: "receiptUsed" });
  await db.store.decideManualPayment(
    w.recorder,
    { ...w.input, decision: "cancel", reason: "Wrong transfer" },
    requestId,
  );
  expect(
    (await db.store.recordManualPayment(w.recorder, { ...w.terms, key: randomUUID() }, requestId))
      .id,
  ).not.toBe(w.id);
});
test.for(["account", "receipt"] as const)(
  "concurrent duplicate %s is refused",
  async (kind, { db }) => {
    const w = await setup(db);
    const first = await db.seedAccount(),
      second = kind === "account" ? first : await db.seedAccount();
    const results = await collision(db, () => [
      db.store.recordManualPayment(
        w.recorder,
        { ...w.terms, key: randomUUID(), accountId: first, receiptHash: "b".repeat(64) },
        requestId,
      ),
      db.store.recordManualPayment(
        w.recorder,
        {
          ...w.terms,
          key: randomUUID(),
          accountId: second,
          receiptHash: (kind === "account" ? "c" : "b").repeat(64),
        },
        requestId,
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: kind === "account" ? "pendingPayment" : "receiptUsed" },
    });
  },
);
test("editing races approval and the stale operation must refresh", async ({ db }) => {
  const w = await setup(db);
  const results = await collision(db, () => [
    db.store.editManualPayment(
      w.recorder,
      {
        ...w.input,
        money: { ...money, minor: 49000n },
        receiptHash: w.terms.receiptHash,
        reference: "Correction",
      },
      requestId,
    ),
    db.store.approveManualPayment(w.a, w.input, requestId),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { code: "refreshConflict" },
  });
});
test("SQL cannot bypass approvals or create another posting", async ({ db }) => {
  const w = await setup(db);
  await expect(
    db.rows(
      "UPDATE payments SET status='completed',completed_by='manualApproval',decided_at=now() WHERE id=$1",
      [w.id],
    ),
  ).rejects.toThrow();
  await expect(
    db.rows(
      "INSERT INTO payment_approvals(id,payment_id,approver_id,role_version,at,request_id) VALUES (gen_random_uuid(),$1,$2,0,now(),$3)",
      [w.id, w.recorder.userId, requestId],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await db.store.approveManualPayment(w.a, w.input, requestId);
  await db.store.approveManualPayment(w.b, w.input, requestId);
  await expect(
    db.rows(
      "INSERT INTO ledger_transactions(id,payment_id,at) VALUES (gen_random_uuid(),$1,now())",
      [w.id],
    ),
  ).rejects.toMatchObject({ code: "23505" });
});
test("agents cannot approve, read ledger lines or another agent's payment", async ({ db }) => {
  const w = await setup(db);
  const agent: Actor = { userId: await db.seedUser("agent"), role: "agent", team: null };
  await expect(db.store.approveManualPayment(agent, w.input, requestId)).rejects.toMatchObject({
    code: "accessDenied",
  });
  await expect(db.store.getPayment(agent, w.id)).rejects.toMatchObject({ code: "accessDenied" });
  await db.rows("UPDATE accounts SET owner_id=$1 WHERE id=$2", [agent.userId, w.accountId]);
  expect((await db.store.getPayment(agent, w.id)).posting).toBeNull();
  await expect(db.store.accountLedger(agent, w.accountId)).rejects.toMatchObject({
    code: "accessDenied",
  });
});
