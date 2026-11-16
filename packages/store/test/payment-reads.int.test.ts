import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { PaymentId, type Actor, type Role } from "@relay/domain";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/client.ts";
import { readAccountLedger } from "../src/payments.ts";
import { test, type TestDatabase } from "../src/testing/index.ts";

const money = { minor: 39500n, currency: "GBP" } as const;

test("account detail returns scoped customer metadata and the payment in progress", async ({
  db,
}) => {
  const agent = await person(db, "agent");
  const manager = await person(db, "manager");
  const stranger = await person(db, "agent");
  const accountId = await account(db, agent);
  const teamId = await db.seedTeam("sales");
  const leadId = await db.seedLead({
    email: "account-detail@example.com",
    lifecycle: {
      state: { status: "won", assignee: { ownerId: agent.userId, teamId }, accountId },
      firstAssignedAt: new Date(),
      previousOwnerId: null,
    },
  });
  await db.rows("UPDATE leads SET name='Account Customer' WHERE id=$1", [leadId]);
  const pending = await db.store.recordManualPayment(
    manager,
    {
      accountId,
      key: randomUUID(),
      money,
      kind: "first",
      receiptHash: "d".repeat(64),
      reference: "Bank transfer",
    },
    randomUUID(),
  );
  const view = await db.store.getAccount(agent, accountId);
  expect(view).toMatchObject({
    person: { name: "Account Customer", email: "account-detail@example.com" },
    mayEdit: true,
    balances: null,
    pendingPayment: { id: pending.id, money, method: "manual", recordedBy: { id: manager.userId } },
  });
  expect(await db.store.getAccount(manager, accountId)).toMatchObject({
    balances: [],
    paymentCount: 1,
  });
  await expect(db.store.getAccount(stranger, accountId)).rejects.toMatchObject({
    code: "accessDenied",
  });
});
async function person(db: TestDatabase, role: Role): Promise<Actor> {
  return { userId: await db.seedUser(role), role, team: null };
}
async function account(db: TestDatabase, owner: Actor) {
  const id = await db.seedAccount();
  await db.ownerRows("UPDATE accounts SET owner_id=$1 WHERE id=$2", [owner.userId, id]);
  return id;
}

test("payment detail returns customer, seller and the provider reference without a payment capability", async ({
  db,
}) => {
  const manager = await person(db, "manager");
  const agent = await person(db, "agent");
  const stranger = await person(db, "agent");
  const accountId = await account(db, agent);
  const teamId = await db.seedTeam("sales");
  const leadId = await db.seedLead({
    email: "customer@example.com",
    lifecycle: {
      state: { status: "won", assignee: { ownerId: agent.userId, teamId }, accountId },
      firstAssignedAt: new Date(),
      previousOwnerId: null,
    },
  });
  await db.rows("UPDATE leads SET name='Fake Customer' WHERE id=$1", [leadId]);
  await db.rows("UPDATE users SET name='Fake Seller' WHERE id=$1", [agent.userId]);
  const { id } = await db.store.createPayment(
    manager,
    { key: randomUUID(), accountId, money, kind: "first", mode: "normal" },
    0,
    randomUUID(),
  );
  const checkout = await db.store.createSandboxCheckout(await db.store.checkoutTerms(manager, id));
  const view = await db.store.getPayment(agent, id);
  expect(view.account).toEqual({ name: "Fake Customer", email: "customer@example.com" });
  expect(view.soldBy).toEqual({ id: agent.userId, name: "Fake Seller" });
  expect(view.providerReference).toBe(checkout.id);
  expect(view.expiresAt).toBeInstanceOf(Date);
  expect(view.postingCount).toBe(0);
  expect(view.receiptAttemptLimit).toBeGreaterThan(0);
  expect(checkout.token).toBeTruthy();
  expect(
    JSON.stringify(view, (_, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  ).not.toContain(checkout.token);
  expect(view).not.toHaveProperty("token");
  expect(view).not.toHaveProperty("url");
  expect(view.posting).toBeNull();
  await expect(db.store.getPayment(stranger, id)).rejects.toMatchObject({ code: "accessDenied" });
});

test("each payment group reports its scoped total beyond the row limit", async ({ db }) => {
  const manager = await person(db, "manager");
  const agent = await person(db, "agent");
  let receipt = 0;
  for (const owner of [agent, manager]) {
    for (const group of ["pendingApproval", "checkoutCreated", "needsReview", "failed"] as const) {
      for (let index = 0; index < 3; index += 1) {
        const accountId = await account(db, owner);
        if (group === "pendingApproval") {
          receipt += 1;
          await db.store.recordManualPayment(
            manager,
            {
              key: randomUUID(),
              accountId,
              money,
              kind: "first",
              receiptHash: receipt.toString(16).padStart(64, "0"),
              reference: null,
            },
            randomUUID(),
          );
          continue;
        }
        const { id } = await db.store.createPayment(
          manager,
          { key: randomUUID(), accountId, money, kind: "first", mode: "drop" },
          0,
          randomUUID(),
        );
        if (group === "failed")
          await db.store.closePaymentCheckout(manager, id, "Fake closed checkout", randomUUID());
        if (group === "needsReview")
          await db.store.receivePaymentWebhook({
            eventId: randomUUID(),
            paymentId: id,
            payloadHash: "fake",
            observed: { status: "completed", money: { ...money, minor: 1n } },
          });
      }
    }
  }
  const view = await db.store.listPayments(agent, 1);
  const next = await db.store.listPayments(agent, 1, 1);
  expect(view.counts).toEqual({
    waitingForApproval: 3,
    waitingForProvider: 3,
    needsReview: 3,
    decidedThisWeek: 3,
  });
  for (const group of [
    "waitingForApproval",
    "waitingForProvider",
    "needsReview",
    "decidedThisWeek",
  ] as const) {
    expect(view[group]).toHaveLength(1);
    expect(view[group][0]?.soldById).toBe(agent.userId);
    expect(next[group]).toHaveLength(1);
    expect(next[group][0]?.id).not.toBe(view[group][0]?.id);
    expect(next[group][0]?.soldById).toBe(agent.userId);
  }
  const ownAccounts = await db.store.listAccounts(agent, { limit: 1 });
  const nextAccounts = await db.store.listAccounts(agent, { limit: 1, offset: 1 });
  expect(ownAccounts.total).toBe(12);
  expect(ownAccounts.items[0]?.balances).toBeNull();
  expect(ownAccounts.items[0]?.mayEdit).toBe(true);
  expect(nextAccounts.items[0]?.id).not.toBe(ownAccounts.items[0]?.id);
  const allAccounts = await db.store.listAccounts(manager, { limit: 1 });
  expect(allAccounts.total).toBe(24);
  expect(allAccounts.items[0]?.balances).toEqual([]);
});

test("the approval read names every maker without giving them approval rights", async ({ db }) => {
  const recorder = await person(db, "manager");
  const editor = await person(db, "manager");
  const checker = await person(db, "owner");
  const id = await account(db, recorder);
  const payment = await db.store.recordManualPayment(
    recorder,
    {
      key: randomUUID(),
      accountId: id,
      money,
      kind: "first",
      receiptHash: "f".repeat(64),
      reference: "Invented receipt",
    },
    randomUUID(),
  );
  await db.store.editManualPayment(
    editor,
    {
      id: payment.id,
      version: 0,
      money,
      receiptHash: "e".repeat(64),
      reference: "Invented edited receipt",
    },
    randomUUID(),
  );
  const view = await db.store.getPayment(checker, payment.id);
  expect(
    view.cannotApprove.map((entry) => ({ userId: entry.user?.id, reason: entry.reason })),
  ).toEqual(
    expect.arrayContaining([
      { userId: recorder.userId, reason: "paymentRecorder" },
      { userId: editor.userId, reason: "paymentMaker" },
    ]),
  );
  expect((await db.store.getPayment(editor, payment.id)).actions.approvalRefusal).toBe(
    "paymentMaker",
  );
});

test("ledger entries batch completion provenance for both system callers and the second approver", async ({
  db,
}) => {
  const manager = await person(db, "manager");
  const first = await person(db, "accountant");
  const second = await person(db, "owner");
  const agent = await person(db, "agent");
  const accountId = await account(db, agent);
  await db.rows("UPDATE users SET name='Fake Second Approver' WHERE id=$1", [second.userId]);
  let queries = 0;
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: db.connectionString }),
    log: [{ emit: "event", level: "query" }],
  });
  client.$on("query", () => {
    queries += 1;
  });
  const read = async () => {
    queries = 0;
    const ledger = await client.$transaction((tx) => readAccountLedger(tx, accountId));
    return { ledger, queries };
  };
  try {
    const webhook = await db.store.createPayment(
      manager,
      { key: randomUUID(), accountId, money, kind: "first", mode: "drop" },
      0,
      randomUUID(),
    );
    await db.store.receivePaymentWebhook({
      eventId: randomUUID(),
      paymentId: webhook.id,
      payloadHash: "fake",
      observed: { status: "completed", money },
    });
    const single = await read();
    const reconciled = await db.store.createPayment(
      manager,
      { key: randomUUID(), accountId, money, kind: "repeat", mode: "drop" },
      0,
      randomUUID(),
    );
    await db.store.finishCheckoutCreation(reconciled.id);
    const token = await db.store.claimPaymentCheck(reconciled.id, new Date(), 1000);
    if (!token) throw new Error("No claim");
    await db.store.finishPaymentCheck(reconciled.id, token, { status: "completed", money });
    const manual = await db.store.recordManualPayment(
      manager,
      {
        key: randomUUID(),
        accountId,
        money,
        kind: "repeat",
        receiptHash: "c".repeat(64),
        reference: "Fake transfer",
      },
      randomUUID(),
    );
    await db.store.approveManualPayment(
      first,
      { id: manual.id, version: 0, roleVersion: 0 },
      randomUUID(),
    );
    await db.store.approveManualPayment(
      second,
      { id: manual.id, version: 0, roleVersion: 0 },
      randomUUID(),
    );
    const multiple = await read();
    expect(multiple.queries).toBe(single.queries);
    const ledger = await db.store.accountLedger(manager, accountId);
    const entries = ledger.balances.flatMap((balance) => balance.entries);
    expect(entries).toHaveLength(3);
    expect(entries.find((entry) => entry.paymentId === webhook.id)?.completion).toMatchObject({
      by: "providerWebhook",
    });
    expect(entries.find((entry) => entry.paymentId === reconciled.id)?.completion).toMatchObject({
      by: "reconciler",
    });
    expect(entries.find((entry) => entry.paymentId === manual.id)?.completion).toMatchObject({
      by: "manualApproval",
      approver: { id: second.userId, name: "Fake Second Approver" },
    });
    expect(ledger.balances[0]?.balance).toBe(3n * money.minor);
    for (const entry of entries) {
      const id = PaymentId.parse(entry.paymentId);
      if (!id) throw new Error("Invalid payment ID");
      const detail = await db.store.getPayment(manager, id);
      expect(entry.completion.at).toBeInstanceOf(Date);
      expect(entry.completion.at).toEqual(
        detail.state.status === "completed" ? detail.state.at : null,
      );
      expect(entry.posting?.lines).toHaveLength(2);
    }
    await expect(db.store.accountLedger(agent, accountId)).rejects.toMatchObject({
      code: "accessDenied",
    });
    expect((await db.store.listAccounts(agent, { limit: 10 })).items[0]?.balances).toBeNull();
  } finally {
    await client.$disconnect();
  }
});
