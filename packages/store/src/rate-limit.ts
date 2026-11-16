import type { Db } from "./tx.ts";

export async function takeRequestLimit(
  db: Db,
  key: string,
  max: number,
  windowSeconds: number,
): Promise<boolean> {
  const accepted = await db.$queryRaw<{ key: string }[]>`
    INSERT INTO auth_request_limits AS budget (key, count, started_at)
    VALUES (${key}, 1, statement_timestamp())
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN budget.started_at <= statement_timestamp() - ${windowSeconds} * interval '1 second'
        THEN 1 ELSE budget.count + 1 END,
      started_at = CASE
        WHEN budget.started_at <= statement_timestamp() - ${windowSeconds} * interval '1 second'
        THEN statement_timestamp() ELSE budget.started_at END
    WHERE budget.count < ${max}
       OR budget.started_at <= statement_timestamp() - ${windowSeconds} * interval '1 second'
    RETURNING key
  `;
  return accepted.length === 1;
}
