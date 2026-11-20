import { channel } from "node:diagnostics_channel";
import { setTimeout as sleep } from "node:timers/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "./generated/client.ts";

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;

const clocks = new WeakMap<Db, () => Date>();
const boundTransactions = new WeakMap<Db, Tx>();

/** Demo setup composes existing operations into one owner transaction. */
export function transactionConnection(db: Db, tx: Tx): Db {
  const bound = new Proxy(db, {
    get(_target, key) {
      if (key === "$disconnect") return () => Promise.resolve();
      if (key === "$transaction")
        return () => {
          throw new Error("A bound seed connection cannot open a transaction. Use transact.");
        };
      const value: unknown = Reflect.get(tx, key, tx);
      return value;
    },
  });
  boundTransactions.set(bound, tx);
  clocks.set(bound, clocks.get(db) ?? (() => new Date()));
  return bound;
}

export function storeNow(db: Db): Date {
  return (clocks.get(db) ?? (() => new Date()))();
}

/** The pool settings a caller may set. Declared here so the published types need no driver. */
export interface StorePoolOptions {
  readonly max?: number | undefined;
  readonly connectionTimeoutMillis?: number | undefined;
}

export function connect(
  connectionString: string,
  clock: () => Date = () => new Date(),
  connection?: Db,
  pool?: StorePoolOptions,
): Db {
  const db =
    connection ?? new PrismaClient({ adapter: new PrismaPg({ ...pool, connectionString }) });
  clocks.set(db, clock);
  return db;
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
 * PostgreSQL can report a race as a unique violation instead of a serialization failure.
 * Only collisions that a fresh snapshot can resolve retry. The catalog test requires an explicit
 * decision for every unique index.
 */
export const RACE_CONSTRAINTS: Readonly<Record<string, "retry" | "reject">> = {
  demo_seed_pkey: "reject",
  activities_sequence_key: "reject",
  job_leases_pkey: "retry",
  payments_in_progress_account_key: "retry",
  payments_live_receipt_key: "retry",
  payment_makers_pkey: "retry",
  payment_approvals_pkey: "reject",
  payment_approvals_active_key: "retry",
  receipt_attempts_pkey: "reject",
  receipt_attempts_outbox_id_number_key: "retry",
  email_suppressions_pkey: "reject",
  payments_pkey: "reject",
  ledger_accounts_pkey: "reject",
  ledger_accounts_account_id_currency_key: "retry",
  ledger_accounts_provider_currency_key: "retry",
  ledger_transactions_pkey: "reject",
  ledger_transactions_payment_id_key: "retry",
  ledger_lines_pkey: "reject",
  payment_events_pkey: "reject",
  webhook_inbox_pkey: "retry",
  outbox_pkey: "reject",
  outbox_payment_id_key: "retry",
  sandbox_checkouts_payment_id_key: "retry",
  sandbox_checkouts_token_hash_key: "reject",
  sandbox_checkouts_pkey: "retry",
  sandbox_checkouts_event_id_key: "reject",
  _prisma_migrations_pkey: "reject",
  accounts_pkey: "reject",
  activities_pkey: "reject",
  audit_log_pkey: "reject",
  auth_accounts_pkey: "reject",
  auth_request_limits_pkey: "retry",
  auth_sessions_pkey: "reject",
  auth_sessions_token_key: "reject",
  auth_verifications_identifier_key: "reject",
  auth_verifications_pkey: "reject",
  distribution_previews_pkey: "reject",
  idempotency_records_pkey: "reject",
  idempotency_records_scope_key_key: "retry",
  intake_events_pkey: "reject",
  intake_events_source_external_id_key: "retry",
  leads_account_id_key: "reject",
  leads_email_key: "retry",
  leads_pkey: "reject",
  memberships_pkey: "reject",
  teams_pkey: "reject",
  users_email_lower_key: "reject",
  users_pkey: "reject",
};

export interface TransactionReport {
  readonly attempts: number;
  readonly committed: boolean;
}

/** Publishes a `TransactionReport` after every `transact` call, so contention can be observed. */
export const transactionReports = channel("relay:store:transaction");
const transactionRetries = channel("relay:store:transaction-retry");

function report(outcome: TransactionReport): void {
  transactionReports.publish(outcome);
}

/**
 * The only place a transaction starts. Every body follows one contract: read the current state,
 * decide, write the difference. Under that contract a serialization failure, a deadlock and a
 * collision on a race constraint all mean "my snapshot went stale", and running the whole body
 * again on a fresh snapshot converges. After the last attempt the original error propagates.
 */
export async function transact<T>(
  db: Db,
  body: (tx: Tx) => Promise<T>,
  options?: { readonly timeoutMs: number; readonly maxAttempts: number },
): Promise<T> {
  const bound = boundTransactions.get(db);
  if (bound) return body(bound);
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await db.$transaction(body, {
        isolationLevel: "Serializable",
        maxWait: 2_000,
        timeout: options?.timeoutMs ?? 5_000,
      });
      report({ attempts: attempt, committed: true });
      return result;
    } catch (error) {
      if (attempt === (options?.maxAttempts ?? MAX_ATTEMPTS) || !isStaleSnapshot(error)) {
        report({ attempts: attempt, committed: false });
        throw error;
      }
      transactionRetries.publish(driverFailure(error));
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
    RACE_CONSTRAINTS[failure.constraint] === "retry"
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
