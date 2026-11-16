import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { Actor } from "@relay/domain";
import { test, type TestDatabase } from "../src/testing/index.ts";

async function card(db: TestDatabase) {
  const actor: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
  const { id } = await db.store.createPayment(
    actor,
    {
      key: randomUUID(),
      accountId: await db.seedAccount(),
      money: { minor: 100n, currency: "GBP" },
      kind: "first",
      mode: "drop",
    },
    0,
    randomUUID(),
  );
  return { actor, id };
}

test.for(["failed", "expired"] as const)(
  "the SQL guard requires paid after close from %s",
  async (status, { db }) => {
    const { id } = await card(db);
    await db.rows(
      "UPDATE payments SET status=$2,decided_at=now(),reason=CASE WHEN $2='failed' THEN 'Closed' ELSE NULL END WHERE id=$1",
      [id, status],
    );
    await expect(
      db.rows(
        "UPDATE payments SET status='needsReview',reason='amount mismatch',reported_amount=1,reported_currency='GBP' WHERE id=$1",
        [id],
      ),
    ).rejects.toMatchObject({ code: "23514", message: "Illegal payment transition" });
  },
);

test("the SQL guard permits only mismatch reasons from a waiting checkout", async ({ db }) => {
  const { id } = await card(db);
  await expect(
    db.rows(
      "UPDATE payments SET status='needsReview',reason='paid after close',reported_amount=100,reported_currency='GBP',decided_at=now() WHERE id=$1",
      [id],
    ),
  ).rejects.toMatchObject({ code: "23514", message: "Illegal payment transition" });
});

test("the store refuses a send timeout equal to or longer than its lease", async ({ db }) => {
  for (const sendTimeoutMs of [1000, 1001])
    await expect(
      db.store.runOutbox(() => Promise.resolve({ state: "sent" }), {
        leaseMs: 1000,
        sendTimeoutMs,
      }),
    ).rejects.toThrow("shorter than the lease");
});

test("closing a checkout independently requires account edit scope", async ({ db }) => {
  const { id } = await card(db);
  const reader: Actor = { userId: await db.seedUser("accountant"), role: "accountant", team: null };
  expect((await db.store.getPayment(reader, id)).state.status).toBe("checkoutCreated");
  await expect(
    db.store.closePaymentCheckout(reader, id, "Close", randomUUID()),
  ).rejects.toMatchObject({ code: "accessDenied" });
  expect((await db.store.getPayment(reader, id)).state.status).toBe("checkoutCreated");
});

test("two card checkouts reach the in-progress unique index", async ({ db }) => {
  const { id } = await card(db);
  await expect(
    db.rows(
      "INSERT INTO payments(id,account_id,amount,currency,method,kind,status,recorded_by_id,created_at,next_check_at,sandbox_mode) SELECT gen_random_uuid(),account_id,amount,currency,method,kind,status,recorded_by_id,now(),now(),sandbox_mode FROM payments WHERE id=$1",
      [id],
    ),
  ).rejects.toMatchObject({ code: "23505", constraint: "payments_in_progress_account_key" });
});

test.for(["pending", "failed", "expired"] as const)(
  "a mismatched %s report enters review without credit",
  async (status, { db }) => {
    const { actor, id } = await card(db);
    await db.store.receivePaymentWebhook({
      eventId: randomUUID(),
      paymentId: id,
      payloadHash: "fake-mismatch",
      observed: { status, money: { minor: 1n, currency: "GBP" } },
    });
    expect((await db.store.getPayment(actor, id)).state).toMatchObject({
      status: "needsReview",
      reason: "amount mismatch",
    });
    expect(await db.rows("SELECT * FROM ledger_transactions")).toHaveLength(0);
  },
);

test("the app credentials can complete a card with a valid posting without provider evidence", async ({
  db,
}) => {
  const { actor, id } = await card(db);
  await db.rows("BEGIN");
  try {
    await db.rows(
      "UPDATE payments SET status='completed',completed_by='reconciler',decided_at=now() WHERE id=$1",
      [id],
    );
    await db.rows(
      `WITH customer AS (INSERT INTO ledger_accounts(id,account_id,kind,currency) SELECT gen_random_uuid(),account_id,'customer',currency FROM payments WHERE id=$1 RETURNING id),
      provider AS (INSERT INTO ledger_accounts(id,kind,currency) VALUES (gen_random_uuid(),'cardProviderSandbox','GBP') RETURNING id),
      posting AS (INSERT INTO ledger_transactions(id,payment_id,at) VALUES (gen_random_uuid(),$1,now()) RETURNING id)
      INSERT INTO ledger_lines(id,transaction_id,ledger_account_id,side,amount)
      SELECT gen_random_uuid(),posting.id,customer.id,'credit',100 FROM posting,customer UNION ALL SELECT gen_random_uuid(),posting.id,provider.id,'debit',100 FROM posting,provider`,
      [id],
    );
    await db.rows(
      "INSERT INTO outbox(id,payment_id,topic,payload,next_attempt_at,created_at) VALUES(gen_random_uuid(),$1,'paymentCompleted','{}',now(),now())",
      [id],
    );
    await db.rows("COMMIT");
  } finally {
    await db.rows("ROLLBACK");
  }
  expect((await db.store.getPayment(actor, id)).state.status).toBe("completed");
  expect(await db.rows("SELECT * FROM webhook_inbox")).toHaveLength(0);
});
