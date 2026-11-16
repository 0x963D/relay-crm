import { randomUUID } from "node:crypto";
import { transact, type Db } from "./tx.ts";

const LEASE_MS = { outbox: 60000, reconcile: 15000, demo: 30000 } as const;

export async function exclusiveJob<T>(
  db: Db,
  route: keyof typeof LEASE_MS,
  run: (signal: AbortSignal) => Promise<T>,
) {
  const token = randomUUID();
  const duration = LEASE_MS[route];
  const acquired = await transact(db, async (tx) => {
    const rows = await tx.$queryRaw<{ token: string }[]>`
      INSERT INTO job_leases(route,token,expires_at)
      VALUES(${route},${token}::uuid,clock_timestamp()+${duration}*interval '1 millisecond')
      ON CONFLICT(route) DO UPDATE SET token=EXCLUDED.token,expires_at=EXCLUDED.expires_at
      WHERE job_leases.expires_at<=clock_timestamp()
      RETURNING token`;
    return rows.length === 1;
  });
  if (!acquired) return { ran: false } as const;
  const controller = new AbortController();
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending
      .then(async () => {
        const renewed = await transact(
          db,
          (tx) => tx.$executeRaw`
        UPDATE job_leases SET expires_at=clock_timestamp()+${duration}*interval '1 millisecond'
        WHERE route=${route} AND token=${token}::uuid AND expires_at>clock_timestamp()`,
        );
        if (renewed !== 1) throw new Error("Scheduled job lease was lost.");
      })
      .catch((error: unknown) => {
        controller.abort(error);
      });
  }, duration / 3);
  timer.unref();
  try {
    const result = await run(controller.signal);
    await pending;
    controller.signal.throwIfAborted();
    return { ran: true, result } as const;
  } finally {
    clearInterval(timer);
    await pending;
    await transact(
      db,
      (tx) => tx.$executeRaw`
      UPDATE job_leases SET expires_at=clock_timestamp() WHERE route=${route} AND token=${token}::uuid`,
    );
  }
}
