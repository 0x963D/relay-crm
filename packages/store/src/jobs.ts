import { transact, type Db } from "./tx.ts";

export function exclusiveJob<T>(db: Db, route: "outbox" | "reconcile", run: () => Promise<T>) {
  return transact(
    db,
    async (tx) => {
      const [lock] = await tx.$queryRaw<
        { acquired: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`relay-job:${route}`},0)) AS acquired`;
      if (!lock?.acquired) return { ran: false } as const;
      return { ran: true, result: await run() } as const;
    },
    { timeoutMs: 3_600_000, maxAttempts: 1 },
  );
}
