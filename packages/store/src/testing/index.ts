import {
  AccountId,
  parseEmail,
  TeamId,
  UserId,
  type LeadId,
  type LeadLifecycle,
  type Role,
  type TeamKind,
} from "@relay/domain";
import pg from "pg";
import { test as base } from "vitest";
import { openStore, type Store } from "../index.ts";
import { insertLead } from "../leads.ts";
import { connect, transactionReports, type TransactionReport } from "../tx.ts";
import { createGate, type Gate } from "./gate.ts";
import { testServer } from "./server.ts";

export type { Gate, TransactionReport };

export interface LeadSeed {
  readonly email: string;
  readonly lifecycle: LeadLifecycle;
  readonly createdAt?: Date;
}

export interface RowCounts {
  readonly leads: number;
  readonly intakeEvents: number;
  readonly activities: number;
}

/** A private database for one test, cloned from the migrated template. */
export interface TestDatabase {
  readonly connectionString: string;
  readonly store: Store;
  readonly gate: Gate;
  /** One report per store transaction since the test began, in the order they finished. */
  readonly transactions: readonly TransactionReport[];
  /** Runs a query and returns its rows, for asserting on what was written. */
  rows(sql: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  /** How many rows intake has written to each of its tables. */
  counts(): Promise<RowCounts>;
  seedUser(role: Role): Promise<UserId>;
  seedTeam(kind: TeamKind): Promise<TeamId>;
  seedAccount(): Promise<AccountId>;
  seedLead(lead: LeadSeed): Promise<LeadId>;
}

function isTransactionReport(message: unknown): message is TransactionReport {
  return (
    typeof message === "object" &&
    message !== null &&
    "attempts" in message &&
    typeof message.attempts === "number" &&
    "committed" in message &&
    typeof message.committed === "boolean"
  );
}

function seeded<T>(value: T | null): T {
  if (value === null) throw new Error("The test database did not return the expected row");
  return value;
}

async function createTestDatabase(): Promise<{
  db: TestDatabase;
  dispose: () => Promise<void>;
}> {
  const server = testServer();
  const name = server.newDatabaseName();
  await server.admin((client) =>
    client.query(
      `CREATE DATABASE ${pg.escapeIdentifier(name)} TEMPLATE ${pg.escapeIdentifier(server.templateName)}`,
    ),
  );
  const connectionString = server.urlFor(name);

  const store = openStore({ connectionString });
  const prisma = connect(connectionString);
  const inspector = new pg.Client({ connectionString });
  const gateSession = new pg.Client({ connectionString });
  await Promise.all([inspector.connect(), gateSession.connect()]);

  const transactions: TransactionReport[] = [];
  const onReport = (message: unknown): void => {
    if (isTransactionReport(message)) transactions.push(message);
  };
  transactionReports.subscribe(onReport);

  let seededRows = 0;
  const db: TestDatabase = {
    connectionString,
    store,
    gate: createGate(gateSession, inspector),
    transactions,
    rows: async (sql, values = []) => {
      const result = await inspector.query<Record<string, unknown>>(sql, [...values]);
      return result.rows;
    },
    counts: async () => {
      const result = await inspector.query<RowCounts>(
        `SELECT (SELECT count(*)::int FROM leads) AS "leads",
                (SELECT count(*)::int FROM intake_events) AS "intakeEvents",
                (SELECT count(*)::int FROM activities) AS "activities"`,
      );
      return seeded(result.rows[0] ?? null);
    },
    seedUser: async (role) => {
      seededRows += 1;
      const user = await prisma.user.create({
        data: { email: `user-${String(seededRows)}@team.example`, name: `${role} user`, role },
        select: { id: true },
      });
      return seeded(UserId.parse(user.id));
    },
    seedTeam: async (kind) => {
      const team = await prisma.team.create({
        data: { name: `${kind} team`, kind },
        select: { id: true },
      });
      return seeded(TeamId.parse(team.id));
    },
    seedAccount: async () => {
      const account = await prisma.account.create({
        data: { createdAt: new Date() },
        select: { id: true },
      });
      return seeded(AccountId.parse(account.id));
    },
    seedLead: async ({ email, lifecycle, createdAt = new Date() }) => {
      const parsed = parseEmail(email);
      if (parsed === null) throw new Error(`Cannot seed a lead with the email ${email}`);
      return insertLead(prisma, { email: parsed, name: null, phone: null, lifecycle, createdAt });
    },
  };

  const dispose = async (): Promise<void> => {
    transactionReports.unsubscribe(onReport);
    await Promise.all([store.close(), prisma.$disconnect(), inspector.end(), gateSession.end()]);
    await server.admin((client) =>
      client.query(`DROP DATABASE ${pg.escapeIdentifier(name)} WITH (FORCE)`),
    );
  };
  return { db, dispose };
}

/**
 * Vitest's `test`, with a `db` fixture: a fresh database per test that is dropped afterwards.
 * Rolling back per test is not an option, because the code under test owns its transactions.
 */
export const test = base.extend<{ db: TestDatabase }>({
  db: async ({}, use) => {
    const { db, dispose } = await createTestDatabase();
    try {
      await use(db);
    } finally {
      await dispose();
    }
  },
});
