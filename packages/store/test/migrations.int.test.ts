import { readFile, readdir } from "node:fs/promises";
import { expect } from "vitest";
import { test } from "../src/testing/index.ts";
import { requestHash } from "../src/idempotency.ts";

test("forward migrations preserve historical receipts and decode audit snapshots", async ({
  db,
}) => {
  await db.ownerRows("CREATE SCHEMA migration_fixture; SET search_path TO migration_fixture");
  const directory = new URL("../prisma/migrations/", import.meta.url);
  const migrations = (await readdir(directory)).filter((name) => /^\d{4}_/.test(name)).sort();
  const apply = async (name: string) =>
    db.ownerRows(await readFile(new URL(`${name}/migration.sql`, directory), "utf8"));
  for (const name of migrations.filter((name) => name < "0008")) await apply(name);
  const actorId = crypto.randomUUID();
  const leadId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const receiptId = crypto.randomUUID();
  const before = { state: { status: "new" }, firstAssignedAt: null, previousOwnerId: null };
  const result = [{ leadId, to: { ownerId: actorId, teamId: crypto.randomUUID() } }];
  const hash = requestHash({ fingerprint: "fingerprint", previewId: crypto.randomUUID() });
  await db.ownerRows(
    "INSERT INTO users(id,email,name,role) VALUES ($1,'staff@example.com','Staff','manager')",
    [actorId],
  );
  await db.ownerRows(
    "INSERT INTO audit_log(id,actor_id,action,subject_id,before,after,at) VALUES ($1,$2,'leadAssigned',$3,$4,$4,now())",
    [auditId, actorId, leadId, JSON.stringify({ lifecycle: JSON.stringify(before) })],
  );
  await db.ownerRows(
    "INSERT INTO distributions(id,actor_id,key,request_hash,result) VALUES ($1,$2,'key',$3,$4)",
    [receiptId, actorId, hash, JSON.stringify(result)],
  );
  const legacyId = crypto.randomUUID();
  await db.ownerRows(
    "INSERT INTO distributions(id,actor_id,key,result) VALUES ($1,$2,'legacy','[]')",
    [legacyId, actorId],
  );
  for (const name of migrations.filter((name) => name >= "0008")) await apply(name);
  expect(
    await db.ownerRows("SELECT request_hash FROM idempotency_records WHERE id=$1", [legacyId]),
  ).toEqual([{ request_hash: `unrecoverable:${legacyId}` }]);
  expect(
    await db.ownerRows(
      "SELECT id,scope,key,request_hash,result FROM idempotency_records WHERE key='key'",
    ),
  ).toEqual([
    {
      id: receiptId,
      scope: `user:${actorId}`,
      key: "key",
      request_hash: hash,
      result: { items: result, changed: true },
    },
  ]);
  expect(
    await db.ownerRows(
      "SELECT id,actor_id,subject_type,subject_id,before,after,request_id,idempotency_id FROM audit_log",
    ),
  ).toEqual([
    {
      id: auditId,
      actor_id: actorId,
      subject_type: "lead",
      subject_id: leadId,
      before: { lifecycle: before },
      after: { lifecycle: before },
      request_id: auditId,
      idempotency_id: null,
    },
  ]);
  await expect(db.ownerRows("UPDATE audit_log SET action='leadReopened'")).rejects.toThrow(
    "append-only",
  );
  await expect(db.ownerRows("DELETE FROM idempotency_records")).rejects.toThrow("append-only");
});

test("forward migration preserves a signed historical posting as credit and debit", async ({
  db,
}) => {
  await db.ownerRows("CREATE SCHEMA ledger_fixture; SET search_path TO ledger_fixture");
  const directory = new URL("../prisma/migrations/", import.meta.url);
  const migrations = (await readdir(directory)).filter((name) => /^\d{4}_/.test(name)).sort();
  for (const name of migrations.filter((name) => name < "0020"))
    await db.ownerRows(await readFile(new URL(`${name}/migration.sql`, directory), "utf8"));
  await db.ownerRows(`BEGIN;
    INSERT INTO users(id,email,name,role) VALUES ('00000000-0000-4000-8000-000000000001','migration@example.com','Historical','manager');
    INSERT INTO accounts(id,created_at) VALUES ('00000000-0000-4000-8000-000000000002',now());
    INSERT INTO payments(id,account_id,amount,currency,kind,status,recorded_by_id,created_at,decided_at,completed_by,next_check_at,sandbox_mode) VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002',100,'GBP','first','completed','00000000-0000-4000-8000-000000000001',now(),now(),'reconciler',now(),'normal');
    INSERT INTO ledger_accounts(id,account_id,kind,currency) VALUES ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000002','customer','GBP'),('00000000-0000-4000-8000-000000000005',NULL,'cardProviderSandbox','GBP');
    INSERT INTO ledger_transactions(id,payment_id,at) VALUES ('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000003',now());
    INSERT INTO ledger_lines(id,transaction_id,ledger_account_id,amount) VALUES (gen_random_uuid(),'00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000004',100),(gen_random_uuid(),'00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000005',-100);
    COMMIT;`);
  await db.ownerRows(await readFile(new URL("0020_ledger_sides/migration.sql", directory), "utf8"));
  expect(await db.ownerRows("SELECT side,amount::text FROM ledger_lines ORDER BY side")).toEqual([
    { side: "credit", amount: "100" },
    { side: "debit", amount: "100" },
  ]);
  await expect(db.ownerRows("UPDATE ledger_lines SET amount=101")).rejects.toThrow("append-only");
});

test("maker migration recovers the last editor and voids their waiting approval", async ({
  db,
}) => {
  await db.ownerRows("CREATE SCHEMA maker_fixture; SET search_path TO maker_fixture");
  const directory = new URL("../prisma/migrations/", import.meta.url);
  const migrations = (await readdir(directory)).filter((name) => /^\d{4}_/.test(name)).sort();
  for (const name of migrations.filter((name) => name < "0024"))
    await db.ownerRows(await readFile(new URL(`${name}/migration.sql`, directory), "utf8"));
  await db.ownerRows(`
 INSERT INTO users(id,email,name,role) VALUES ('00000000-0000-4000-8000-000000000001','recorder@example.com','Recorder','manager'),('00000000-0000-4000-8000-000000000002','editor@example.com','Editor','manager');
 INSERT INTO accounts(id,created_at) VALUES ('00000000-0000-4000-8000-000000000003',now());
 INSERT INTO payments(id,account_id,amount,currency,method,kind,status,recorded_by_id,created_at,receipt_hash) VALUES ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003',48000,'GBP','manual','first','pendingApproval','00000000-0000-4000-8000-000000000001',now(),repeat('a',64));
 UPDATE payments SET amount=4800000,version=1;
 INSERT INTO payment_events(payment_id,kind,at,detail) VALUES ('00000000-0000-4000-8000-000000000004','edited',now(),'{"actorId":"00000000-0000-4000-8000-000000000002"}');
 INSERT INTO payment_approvals(id,payment_id,approver_id,role_version,at,request_id) VALUES (gen_random_uuid(),'00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000002',0,now(),gen_random_uuid());`);
  for (const name of migrations.filter((name) => name >= "0024"))
    await db.ownerRows(await readFile(new URL(`${name}/migration.sql`, directory), "utf8"));
  expect(await db.ownerRows("SELECT terms_set_by_id FROM payments")).toEqual([
    { terms_set_by_id: "00000000-0000-4000-8000-000000000002" },
  ]);
  expect(
    await db.ownerRows(
      "SELECT payment_version,voided_at IS NOT NULL AS voided FROM payment_approvals",
    ),
  ).toEqual([{ payment_version: 1, voided: true }]);
});
