import { expect } from "vitest";
import { test } from "../src/testing/index.ts";

test("audit rows name one human or one closed system actor", async ({ db }) => {
  const user = await db.seedUser("manager");
  const subject = crypto.randomUUID();
  const insert = (actor: string | null, system: string | null) =>
    db.rows(
      "INSERT INTO audit_log(id,actor_id,system_actor,action,subject_id,before,after,at) VALUES (gen_random_uuid(),$1,$2,'leadAssigned',$3,'{}','{}',now()) RETURNING actor_id,system_actor",
      [actor, system, subject],
    );
  expect(await insert(null, "intake")).toEqual([{ actor_id: null, system_actor: "intake" }]);
  expect(await insert(user, null)).toEqual([{ actor_id: user, system_actor: null }]);
  await expect(insert(null, null)).rejects.toMatchObject({ code: "23514" });
  await expect(insert(user, "intake")).rejects.toMatchObject({ code: "23514" });
  await expect(insert(null, "unknown")).rejects.toThrow();
});
