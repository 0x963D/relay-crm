import { randomUUID } from "node:crypto";
import { transact, type Db } from "./tx.ts";

export async function exclusiveJob<T>(
  db: Db,
  route: "outbox" | "reconcile" | "demo",
  run: () => Promise<T>,
) {
  const token = randomUUID();
  const acquired = await transact(db, async (tx) => {
    const rows = await tx.$queryRaw<{ token: string }[]>`
      INSERT INTO job_leases(route,token,expires_at)
      VALUES(${route},${token}::uuid,now()+interval '1 hour')
      ON CONFLICT(route) DO UPDATE SET token=EXCLUDED.token,expires_at=EXCLUDED.expires_at
      WHERE job_leases.expires_at<=now()
      RETURNING token`;
    return rows.length === 1;
  });
  if (!acquired) return { ran: false } as const;
  try {
    return { ran: true, result: await run() } as const;
  } finally {
    await transact(
      db,
      (tx) => tx.$executeRaw`
      UPDATE job_leases SET expires_at=now() WHERE route=${route} AND token=${token}::uuid`,
    );
  }
}
