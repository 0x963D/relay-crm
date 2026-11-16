import type { Db } from "./tx.ts";

export async function takeRequestLimit(
  db: Db,
  key: string,
  max: number,
  windowSeconds: number,
): Promise<boolean> {
  const accepted = await db.$queryRaw<{ key: string }[]>`
    WITH expired AS (
      SELECT key FROM auth_request_limits
      WHERE key <> ${key}
        AND started_at <= statement_timestamp() - window_seconds * interval '1 second'
      ORDER BY started_at, key LIMIT 100 FOR UPDATE SKIP LOCKED
    ), removed AS (
      DELETE FROM auth_request_limits AS budget USING expired WHERE budget.key=expired.key
    )
    INSERT INTO auth_request_limits AS budget (key, count, started_at, window_seconds)
    VALUES (${key}, 1, statement_timestamp(), ${windowSeconds})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN budget.started_at <= statement_timestamp() - budget.window_seconds * interval '1 second'
        THEN 1 ELSE budget.count + 1 END,
      window_seconds = CASE
        WHEN budget.started_at <= statement_timestamp() - budget.window_seconds * interval '1 second'
        THEN ${windowSeconds} ELSE budget.window_seconds END,
      started_at = CASE
        WHEN budget.started_at <= statement_timestamp() - budget.window_seconds * interval '1 second'
        THEN statement_timestamp() ELSE budget.started_at END
    WHERE budget.count < ${max}
       OR budget.started_at <= statement_timestamp() - budget.window_seconds * interval '1 second'
    RETURNING key
  `;
  return accepted.length === 1;
}
