import { expect } from "vitest";
import { test } from "../src/testing/index.ts";

test("audit rows name one human or one closed system actor", async ({ db }) => {
  const user = await db.seedUser("manager");
  const subject = crypto.randomUUID();
  const insert = (actor: string | null, system: string | null) =>
    db.rows(
      "INSERT INTO audit_log(subject_type,request_id,id,actor_id,system_actor,action,subject_id,before,after,at) VALUES ('lead',gen_random_uuid(),gen_random_uuid(),$1,$2,'leadAssigned',$3,'{}','{}',now())",
      [actor, system, subject],
    );
  await insert(null, "intake");
  await insert(user, null);
  expect(
    await db.ownerRows(
      "SELECT actor_id,system_actor FROM audit_log ORDER BY system_actor NULLS LAST",
    ),
  ).toEqual([
    { actor_id: null, system_actor: "intake" },
    { actor_id: user, system_actor: null },
  ]);
  await expect(insert(null, null)).rejects.toMatchObject({ code: "23514" });
  await expect(insert(user, "intake")).rejects.toMatchObject({ code: "23514" });
  await expect(insert(null, "unknown")).rejects.toThrow();
});

test("audit constraints refuse unknown actions, subjects, missing causes and encoded snapshots", async ({
  db,
}) => {
  const user = await db.seedUser("manager");
  const insert = (
    action: string,
    subject: string,
    before: unknown,
    after: unknown,
    request: string | null = crypto.randomUUID(),
    receipt: string | null = null,
  ) =>
    db.rows(
      "INSERT INTO audit_log(id,actor_id,subject_type,subject_id,action,before,after,request_id,idempotency_id,at) VALUES (gen_random_uuid(),$1,$2,gen_random_uuid(),$3,$4::jsonb,$5::jsonb,$6,$7,now())",
      [user, subject, action, JSON.stringify(before), JSON.stringify(after), request, receipt],
    );
  await expect(insert("unknown", "lead", {}, {})).rejects.toMatchObject({ code: "22P02" });
  await expect(insert("leadAssigned", "unknown", {}, {})).rejects.toMatchObject({ code: "22P02" });
  for (const value of ["{}", [], null, { lifecycle: "{}" }]) {
    await expect(insert("leadAssigned", "lead", value, {})).rejects.toMatchObject({
      code: "23514",
    });
    await expect(insert("leadAssigned", "lead", {}, value)).rejects.toMatchObject({
      code: "23514",
    });
  }
  await expect(insert("leadAssigned", "lead", {}, {}, null)).rejects.toMatchObject({
    code: "23502",
  });
  const missing = crypto.randomUUID();
  await expect(insert("leadAssigned", "lead", {}, {}, missing, missing)).rejects.toMatchObject({
    code: "23503",
  });
});
