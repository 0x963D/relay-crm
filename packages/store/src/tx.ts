import { channel } from "node:diagnostics_channel";
import { setTimeout as sleep } from "node:timers/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "./generated/client.ts";

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;

export function connect(connectionString: string): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/**
 * Serializable isolation locks whole index pages, so on small tables concurrent intakes conflict
 * even for unrelated people and a burst resolves close to serially. Ten attempts is what that
 * costs. In a measured burst of 12 the slowest call took 6, and 9 once every insert was slowed by
 * 30 ms. Past the limit the sender retries, which the ledger makes safe.
 */
const MAX_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 200;

const SERIALIZATION_FAILURE = "40001";
const DEADLOCK_DETECTED = "40P01";
const UNIQUE_VIOLATION = "23505";

/**
 * The unique indexes two concurrent intakes can collide on. PostgreSQL may report such a collision
 * as a unique violation where a serialization failure was expected, so a violation of one of
 * these is retried. A violation of any other unique index is a bug and is not.
 */
export const RACE_CONSTRAINTS: readonly string[] = [
  "leads_email_key",
  "idempotency_records_scope_key_key",
  "auth_request_limits_pkey",
  "intake_events_source_external_id_key",
];

export interface TransactionReport {
  readonly attempts: number;
  readonly committed: boolean;
}

/** Publishes a `TransactionReport` after every `transact` call, so contention can be observed. */
export const transactionReports = channel("relay:store:transaction");

function report(outcome: TransactionReport): void {
  transactionReports.publish(outcome);
}

/**
 * The only place a transaction starts. Every body follows one contract: read the current state,
 * decide, write the difference. Under that contract a serialization failure, a deadlock and a
 * collision on a race constraint all mean "my snapshot went stale", and running the whole body
 * again on a fresh snapshot converges. After the last attempt the original error propagates.
 */
export async function transact<T>(db: Db, body: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await db.$transaction(body, {
        isolationLevel: "Serializable",
        maxWait: 2_000,
        timeout: 5_000,
      });
      report({ attempts: attempt, committed: true });
      return result;
    } catch (error) {
      if (attempt === MAX_ATTEMPTS || !isStaleSnapshot(error)) {
        report({ attempts: attempt, committed: false });
        throw error;
      }
      await sleep(Math.random() * Math.min(MAX_BACKOFF_MS, 10 * 2 ** attempt));
    }
  }
}

export function isStaleSnapshot(error: unknown): boolean {
  const failure = driverFailure(error);
  if (failure === null) return read(error, "code") === "P2034";
  if (failure.sqlState === SERIALIZATION_FAILURE || failure.sqlState === DEADLOCK_DETECTED) {
    return true;
  }
  return (
    failure.sqlState === UNIQUE_VIOLATION &&
    failure.constraint !== null &&
    RACE_CONSTRAINTS.includes(failure.constraint)
  );
}

interface DriverFailure {
  readonly sqlState: string;
  readonly constraint: string | null;
}

/**
 * Prisma reports a failed statement as a known request error that carries the driver's error in
 * `meta.driverAdapterError`. It reports a failed COMMIT as the driver's error itself, with no
 * Prisma code. Both keep PostgreSQL's SQLSTATE in `cause.originalCode`, so that is what is read.
 * test/tx.int.test.ts pins each of these shapes against a real database.
 */
function driverFailure(error: unknown): DriverFailure | null {
  for (const candidate of [error, read(read(error, "meta"), "driverAdapterError")]) {
    const cause = read(candidate, "cause");
    const sqlState = read(cause, "originalCode");
    if (typeof sqlState === "string") {
      const constraint = read(read(cause, "constraint"), "index");
      return { sqlState, constraint: typeof constraint === "string" ? constraint : null };
    }
  }
  return null;
}

function read(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}
