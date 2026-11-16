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

export interface TestDatabase {
  readonly connectionString: string;
  readonly ownerConnectionString: string;
  readonly store: Store;
  readonly gate: Gate;
  readonly transactions: readonly TransactionReport[];
  ownerRows(sql: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  rows(sql: string, values?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
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

export async function createTestDatabase(): Promise<{
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
  const owner = new pg.Client({ connectionString: server.ownerUrlFor(name) });
  const inspector = new pg.Client({ connectionString });
  const gateSession = new pg.Client({ connectionString: server.ownerUrlFor(name) });
  await Promise.all([inspector.connect(), gateSession.connect(), owner.connect()]);

  const transactions: TransactionReport[] = [];
  const onReport = (message: unknown): void => {
    if (isTransactionReport(message)) transactions.push(message);
  };
  transactionReports.subscribe(onReport);

  let seededRows = 0;
  const db: TestDatabase = {
    connectionString,
    ownerConnectionString: server.ownerUrlFor(name),
    store,
    gate: createGate(gateSession, inspector),
    transactions,
    ownerRows: async (sql, values = []) =>
      (await owner.query<Record<string, unknown>>(sql, [...values])).rows,
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
      const result = await owner.query<{ id: string }>(
        "INSERT INTO teams(id,name,kind) VALUES (gen_random_uuid(),$1,$2) RETURNING id",
        [`${kind} team`, kind],
      );
      return seeded(TeamId.parse(seeded(result.rows[0] ?? null).id));
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
      if (!parsed.ok) throw new Error(`Cannot seed a lead with the email ${email}`);
      return insertLead(prisma, {
        email: parsed.value,
        name: null,
        phone: null,
        lifecycle,
        createdAt,
      });
    },
  };

  const dispose = async (): Promise<void> => {
    transactionReports.unsubscribe(onReport);
    await Promise.all([
      store.close(),
      prisma.$disconnect(),
      inspector.end(),
      gateSession.end(),
      owner.end(),
    ]);
    await server.dropDatabase(name);
  };
  return { db, dispose };
}

export { default as prepareTestServer } from "./global-setup.ts";
