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
  for (const name of migrations.filter((name) => name >= "0008")) await apply(name);
  expect(await db.rows("SELECT id,scope,key,request_hash,result FROM idempotency_records")).toEqual(
    [
      {
        id: receiptId,
        scope: `user:${actorId}`,
        key: "key",
        request_hash: hash,
        result: { items: result, changed: true },
      },
    ],
  );
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
