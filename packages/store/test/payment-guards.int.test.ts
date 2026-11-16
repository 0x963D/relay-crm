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

async function staleApproval(db: TestDatabase) {
  const w = await waiting(db);
  await db.store.approveManualPayment(w.a, w.input, requestId);
  await db.ownerRows("ALTER TABLE users DISABLE TRIGGER users_void_approvals");
  await db.rows("UPDATE users SET role='manager' WHERE id=$1", [w.a.userId]);
  await db.ownerRows("ALTER TABLE users ENABLE TRIGGER users_void_approvals");
  return w;
}

test("approval insert independently compares the current role version", async ({ db }) => {
  const w = await waiting(db);
  await db.rows("UPDATE users SET role='manager' WHERE id=$1", [w.a.userId]);
  await expect(
    db.rows(
      "INSERT INTO payment_approvals(id,payment_id,approver_id,role_version,at,request_id) VALUES (gen_random_uuid(),$1,$2,0,now(),$3)",
      [w.id, w.a.userId, requestId],
    ),
  ).rejects.toMatchObject({ code: "23514" });
});

test("completion independently compares both approval role versions", async ({ db }) => {
  const w = await staleApproval(db);
  await db.rows(
    "INSERT INTO payment_approvals(id,payment_id,approver_id,role_version,at,request_id) VALUES (gen_random_uuid(),$1,$2,0,now(),$3)",
    [w.id, w.b.userId, requestId],
  );
  await refusesCompletion(db, w.id);
});

test("the second approval rechecks the other approver role version in the application", async ({
  db,
}) => {
  const w = await staleApproval(db);
  await db.ownerRows("ALTER TABLE payments DISABLE TRIGGER manual_approvals_required");
  try {
    await expect(db.store.approveManualPayment(w.b, w.input, requestId)).rejects.toMatchObject({
      code: "roleChanged",
    });
  } finally {
    await db.ownerRows("ALTER TABLE payments ENABLE TRIGGER manual_approvals_required");
  }
  expect((await db.store.getPayment(w.b, w.id)).state.status).toBe("pendingApproval");
});

test.for([
  "intake_events",
  "activities",
  "audit_log",
  "distribution_previews",
  "idempotency_records",
  "ledger_accounts",
  "ledger_transactions",
  "ledger_lines",
  "payment_events",
  "webhook_inbox",
  "payment_approvals",
  "receipt_attempts",
  "outbox",
] as const)("standalone truncate refuses %s", async (table, { db }) => {
  await db.ownerRows("BEGIN");
  try {
    const references = await db.ownerRows(
      "SELECT format('ALTER TABLE %I.%I DROP CONSTRAINT %I',n.nspname,c.relname,f.conname) AS statement FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE f.contype='f' AND f.confrelid=$1::regclass",
      [`public.${table}`],
    );
    for (const row of references) await db.ownerRows(String(row.statement));
    await expect(db.ownerRows(`TRUNCATE ${table}`)).rejects.toMatchObject({
      code: "23001",
      message: `${table} is append-only`,
    });
  } finally {
    await db.ownerRows("ROLLBACK");
  }
});

test("the database refuses duplicate active approvals but permits a fresh approval after voiding", async ({
  db,
}) => {
  const w = await waiting(db);
  await db.store.approveManualPayment(w.a, w.input, requestId);
  await expect(
    db.rows(
      "INSERT INTO payment_approvals(id,payment_id,approver_id,role_version,at,request_id) VALUES (gen_random_uuid(),$1,$2,0,now(),$3)",
      [w.id, w.a.userId, requestId],
    ),
  ).rejects.toMatchObject({ code: "23505", constraint: "payment_approvals_active_key" });
  await db.rows("UPDATE users SET role='manager' WHERE id=$1", [w.a.userId]);
  await db.rows(
    "INSERT INTO payment_approvals(id,payment_id,approver_id,role_version,at,request_id) VALUES (gen_random_uuid(),$1,$2,1,now(),$3)",
    [w.id, w.a.userId, requestId],
  );
  expect(
    await db.rows(
      "SELECT count(*)::int AS total,count(*) FILTER(WHERE voided_at IS NULL)::int AS active FROM payment_approvals WHERE payment_id=$1",
      [w.id],
    ),
  ).toEqual([{ total: 2, active: 1 }]);
});

test("completion refuses a maker even alongside two eligible approvals", async ({ db }) => {
  const w = await waiting(db);
  await db.ownerRows("ALTER TABLE payment_approvals DISABLE TRIGGER payment_approvals_guard");
  await db.rows(
    "INSERT INTO payment_approvals(id,payment_id,approver_id,role_version,payment_version,at,request_id) SELECT gen_random_uuid(),$1,u,0,0,now(),$3 FROM unnest($2::uuid[]) AS u",
    [w.id, [w.recorder.userId, w.a.userId, w.b.userId], requestId],
  );
  await db.ownerRows("ALTER TABLE payment_approvals ENABLE TRIGGER payment_approvals_guard");
  await refusesCompletion(db, w.id);
});
