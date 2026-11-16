import { setTimeout as sleep } from "node:timers/promises";
import type pg from "pg";

const POLL_MS = 10;
const WAIT_LIMIT_MS = 10_000;

/**
 * Makes a race deterministic without a seam in product code. While the gate is closed, a
 * separate session holds SHARE locks on the tables intake writes. Reads pass, so each racer takes
 * its snapshot and decides, and then parks on its first write. Once every racer is parked, they
 * have all decided on the same stale state, and opening the gate lets them collide.
 */
export interface Gate {
  close(table?: "payments" | "outbox"): Promise<void>;
  waitForWaiters(count: number): Promise<void>;
  open(): Promise<void>;
}

/**
 * `holder` keeps the locks inside a transaction. `watcher` must be a different session with no
 * open transaction. PostgreSQL freezes pg_stat_activity at a transaction's first read of it, so
 * the holder would never see a waiter arrive.
 */
export function createGate(holder: pg.Client, watcher: pg.Client): Gate {
  return {
    close: async (table) => {
      await holder.query("BEGIN");
      await holder.query(
        table === "outbox"
          ? "LOCK TABLE outbox IN SHARE MODE"
          : table === "payments"
            ? "LOCK TABLE payments IN SHARE MODE"
            : "LOCK TABLE leads, intake_events, activities IN SHARE MODE",
      );
    },
    waitForWaiters: async (count) => {
      let waiting = 0;
      for (let waited = 0; waited < WAIT_LIMIT_MS; waited += POLL_MS) {
        const result = await watcher.query<{ waiting: number }>(
          `SELECT count(*)::int AS waiting FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        waiting = result.rows[0]?.waiting ?? 0;
        if (waiting >= count) return;
        await sleep(POLL_MS);
      }
      throw new Error(`Only ${String(waiting)} of ${String(count)} sessions reached the gate`);
    },
    open: async () => {
      await holder.query("COMMIT");
    },
  };
}
