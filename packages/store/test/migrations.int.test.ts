import { readFile, readdir } from "node:fs/promises";
import { expect } from "vitest";
import { test } from "../src/testing/index.ts";
import { requestHash } from "../src/idempotency.ts";

test("forward migrations preserve historical receipts and decode audit snapshots", async ({
  db,
}) => {
  await db.rows("CREATE SCHEMA migration_fixture; SET search_path TO migration_fixture");
  const directory = new URL("../prisma/migrations/", import.meta.url);
  const migrations = (await readdir(directory)).filter((name) => /^\d{4}_/.test(name)).sort();
  const apply = async (name: string) =>
    db.rows(await readFile(new URL(`${name}/migration.sql`, directory), "utf8"));
  for (const name of migrations.filter((name) => name < "0008")) await apply(name);
  const actorId = crypto.randomUUID();
  const leadId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const receiptId = crypto.randomUUID();
  const before = { state: { status: "new" }, firstAssignedAt: null, previousOwnerId: null };
  const result = [{ leadId, to: { ownerId: actorId, teamId: crypto.randomUUID() } }];
  const hash = requestHash({ fingerprint: "fingerprint", previewId: crypto.randomUUID() });
  await db.rows(
    "INSERT INTO users(id,email,name,role) VALUES ($1,'staff@example.com','Staff','manager')",
    [actorId],
  );
  await db.rows(
    "INSERT INTO audit_log(id,actor_id,action,subject_id,before,after,at) VALUES ($1,$2,'leadAssigned',$3,$4,$4,now())",
    [auditId, actorId, leadId, JSON.stringify({ lifecycle: JSON.stringify(before) })],
  );
  await db.rows(
    "INSERT INTO distributions(id,actor_id,key,request_hash,result) VALUES ($1,$2,'key',$3,$4)",
    [receiptId, actorId, hash, JSON.stringify(result)],
  );
  const legacyId = crypto.randomUUID();
  await db.rows("INSERT INTO distributions(id,actor_id,key,result) VALUES ($1,$2,'legacy','[]')", [
    legacyId,
    actorId,
  ]);
  for (const name of migrations.filter((name) => name >= "0008")) await apply(name);
  expect(
    await db.rows("SELECT request_hash FROM idempotency_records WHERE id=$1", [legacyId]),
  ).toEqual([{ request_hash: `unrecoverable:${legacyId}` }]);
  expect(
    await db.rows(
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
    await db.rows(
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
  await expect(db.rows("UPDATE audit_log SET action='leadReopened'")).rejects.toThrow(
    "append-only",
  );
  await expect(db.rows("DELETE FROM idempotency_records")).rejects.toThrow("append-only");
});

test("forward migration preserves a signed historical posting as credit and debit", async ({
  db,
}) => {
  await db.rows("CREATE SCHEMA ledger_fixture; SET search_path TO ledger_fixture");
  const directory = new URL("../prisma/migrations/", import.meta.url);
  const migrations = (await readdir(directory)).filter((name) => /^\d{4}_/.test(name)).sort();
  for (const name of migrations.filter((name) => name < "0020"))
    await db.rows(await readFile(new URL(`${name}/migration.sql`, directory), "utf8"));
  await db.rows(`BEGIN;
    INSERT INTO users(id,email,name,role) VALUES ('00000000-0000-4000-8000-000000000001','migration@example.com','Historical','manager');
    INSERT INTO accounts(id,created_at) VALUES ('00000000-0000-4000-8000-000000000002',now());
    INSERT INTO payments(id,account_id,amount,currency,kind,status,recorded_by_id,created_at,decided_at,completed_by,next_check_at,sandbox_mode) VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002',100,'GBP','first','completed','00000000-0000-4000-8000-000000000001',now(),now(),'reconciler',now(),'normal');
    INSERT INTO ledger_accounts(id,account_id,kind,currency) VALUES ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000002','customer','GBP'),('00000000-0000-4000-8000-000000000005',NULL,'cardProviderSandbox','GBP');
    INSERT INTO ledger_transactions(id,payment_id,at) VALUES ('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000003',now());
    INSERT INTO ledger_lines(id,transaction_id,ledger_account_id,amount) VALUES (gen_random_uuid(),'00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000004',100),(gen_random_uuid(),'00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000005',-100);
    COMMIT;`);
  await db.rows(await readFile(new URL("0020_ledger_sides/migration.sql", directory), "utf8"));
  expect(await db.rows("SELECT side,amount::text FROM ledger_lines ORDER BY side")).toEqual([
    { side: "credit", amount: "100" },
    { side: "debit", amount: "100" },
  ]);
  await expect(db.rows("UPDATE ledger_lines SET amount=101")).rejects.toThrow("append-only");
});
