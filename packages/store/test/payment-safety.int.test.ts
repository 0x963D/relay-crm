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
      "INSERT INTO payments(id,account_id,amount,currency,kind,status,recorded_by_id,created_at,next_check_at,sandbox_mode) SELECT gen_random_uuid(),account_id,amount,currency,kind,status,recorded_by_id,now(),now(),sandbox_mode FROM payments WHERE id=$1",
      [id],
    ),
  ).rejects.toMatchObject({ code: "23505", constraint: "payments_in_progress_account_key" });
});
