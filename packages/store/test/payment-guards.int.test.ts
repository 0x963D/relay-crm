import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { Actor, Role } from "@relay/domain";
import { test, type TestDatabase } from "../src/testing/index.ts";

const requestId = "00000000-0000-4000-8000-000000000001";
async function waiting(db: TestDatabase) {
  const person = async (role: Role): Promise<Actor> => ({
    userId: await db.seedUser(role),
    role,
    team: null,
  });
  const recorder = await person("manager"),
    a = await person("accountant"),
    b = await person("manager");
  const terms = {
    accountId: await db.seedAccount(),
    key: randomUUID(),
    money: { minor: 48000n, currency: "GBP" as const },
    kind: "first" as const,
    receiptHash: "a".repeat(64),
    reference: null,
  };
  const { id } = await db.store.recordManualPayment(recorder, terms, requestId);
  return { recorder, a, b, terms, id, input: { id, version: 0, roleVersion: 0 } };
}
async function refusesCompletion(db: TestDatabase, id: string) {
  await db.ownerRows("BEGIN; SET CONSTRAINTS manual_approvals_required IMMEDIATE");
  try {
    await expect(
      db.ownerRows(
        "UPDATE payments SET status='completed',completed_by='manualApproval',decided_at=now() WHERE id=$1",
        [id],
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "manual_approvals_required" });
  } finally {
    await db.ownerRows("ROLLBACK");
  }
}

test("completion independently excludes the recorder when another person last edited", async ({
  db,
}) => {
  const w = await waiting(db);
  await db.store.editManualPayment(w.b, { ...w.input, ...w.terms }, requestId);
  await db.ownerRows("ALTER TABLE payment_approvals DISABLE TRIGGER payment_approvals_guard");
  await db.rows(
    "INSERT INTO payment_approvals(id,payment_id,approver_id,role_version,payment_version,at,request_id) VALUES (gen_random_uuid(),$1,$2,0,1,now(),$4),(gen_random_uuid(),$1,$3,0,1,now(),$4)",
    [w.id, w.recorder.userId, w.a.userId, requestId],
  );
  await db.ownerRows("ALTER TABLE payment_approvals ENABLE TRIGGER payment_approvals_guard");
  await refusesCompletion(db, w.id);
});
