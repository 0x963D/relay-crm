import { describe, expect } from "vitest";
import { test, type TestDatabase } from "../src/testing/index.ts";
import { connect, isStaleSnapshot, RACE_CONSTRAINTS, transact, type Db } from "../src/tx.ts";

const SERIALIZABLE = { isolationLevel: "Serializable", maxWait: 2_000, timeout: 5_000 } as const;

const latch = (): PromiseWithResolvers<void> => Promise.withResolvers();

async function withClient<T>(db: TestDatabase, run: (prisma: Db) => Promise<T>): Promise<T> {
  const prisma = connect(db.connectionString);
  try {
    return await run(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the transaction to fail");
}

/**
 * These tests pin how Prisma 7 with the pg adapter reports each failure the retry rule depends
 * on. They run the real driver against a real database, so an upgrade that changes a shape fails
 * here instead of silently turning retries off.
 */
describe("how a stale snapshot surfaces", () => {
  test("a concurrent update fails the statement with P2034 and SQLSTATE 40001", async ({ db }) => {
    await withClient(db, async (prisma) => {
      const team = await prisma.team.create({ data: { name: "one", kind: "sales" } });
      const hasRead = latch();
      const mayWrite = latch();

      const loser = prisma.$transaction(async (tx) => {
        await tx.team.findUnique({ where: { id: team.id } });
        hasRead.resolve();
        await mayWrite.promise;
        await tx.team.update({ where: { id: team.id }, data: { name: "loser" } });
      }, SERIALIZABLE);
      const failure = failureOf(loser);

      await hasRead.promise;
      await prisma.team.update({ where: { id: team.id }, data: { name: "winner" } });
      mayWrite.resolve();

      const error = await failure;
      expect(error).toMatchObject({
        name: "PrismaClientKnownRequestError",
        code: "P2034",
        meta: { driverAdapterError: { cause: { originalCode: "40001" } } },
      });
      expect(isStaleSnapshot(error)).toBe(true);
    });
  });

  test("write skew fails the COMMIT with a bare driver error and SQLSTATE 40001", async ({
    db,
  }) => {
    await withClient(db, async (prisma) => {
      const mayWrite = latch();
      const skewed = (reads: "sales" | "accounts", writes: "sales" | "accounts") => {
        const hasRead = latch();
        const hasWritten = latch();
        const mayCommit = latch();
        const done = prisma.$transaction(async (tx) => {
          await tx.team.count({ where: { kind: reads } });
          hasRead.resolve();
          await mayWrite.promise;
          await tx.team.create({ data: { name: `writes ${writes}`, kind: writes } });
          hasWritten.resolve();
          await mayCommit.promise;
        }, SERIALIZABLE);
        return { hasRead, hasWritten, mayCommit, done };
      };

      const first = skewed("sales", "accounts");
      const second = skewed("accounts", "sales");
      const failure = failureOf(second.done);

      await Promise.all([first.hasRead.promise, second.hasRead.promise]);
      mayWrite.resolve();
      await Promise.all([first.hasWritten.promise, second.hasWritten.promise]);
      first.mayCommit.resolve();
      await first.done;
      second.mayCommit.resolve();

      const error = await failure;
      expect(error).toMatchObject({
        name: "DriverAdapterError",
        cause: { originalCode: "40001", kind: "TransactionWriteConflict" },
      });
      expect(error).not.toHaveProperty("code");
      expect(isStaleSnapshot(error)).toBe(true);
    });
  });

  test("a deadlock fails one transaction with P2034 and SQLSTATE 40P01", async ({ db }) => {
    await withClient(db, async (prisma) => {
      const a = await prisma.team.create({ data: { name: "a", kind: "sales" } });
      const b = await prisma.team.create({ data: { name: "b", kind: "sales" } });
      const holdsA = latch();
      const holdsB = latch();

      const lockBoth = (
        firstId: string,
        secondId: string,
        mine: PromiseWithResolvers<void>,
        theirs: PromiseWithResolvers<void>,
      ) =>
        prisma.$transaction(async (tx) => {
          await tx.team.update({ where: { id: firstId }, data: { name: "held" } });
          mine.resolve();
          await theirs.promise;
          await tx.team.update({ where: { id: secondId }, data: { name: "wanted" } });
        });

      const outcomes = await Promise.allSettled([
        lockBoth(a.id, b.id, holdsA, holdsB),
        lockBoth(b.id, a.id, holdsB, holdsA),
      ]);

      const failures: unknown[] = [];
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") failures.push(outcome.reason);
      }
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        code: "P2034",
        meta: { driverAdapterError: { cause: { originalCode: "40P01" } } },
      });
      expect(isStaleSnapshot(failures[0])).toBe(true);
    });
  });

  test("a unique violation is P2002 and names the index, so only race constraints retry", async ({
    db,
  }) => {
    await withClient(db, async (prisma) => {
      const user = { email: "dup@team.example", name: "dup", role: "agent" } as const;
      await prisma.user.create({ data: user });
      const error = await failureOf(
        prisma.$transaction(async (tx) => {
          await tx.user.create({ data: user });
        }, SERIALIZABLE),
      );

      expect(error).toMatchObject({
        name: "PrismaClientKnownRequestError",
        code: "P2002",
        meta: {
          driverAdapterError: {
            cause: { originalCode: "23505", constraint: { index: "users_email_key" } },
          },
        },
      });
      expect(RACE_CONSTRAINTS).not.toContain("users_email_key");
      expect(isStaleSnapshot(error)).toBe(false);
    });
  });

  test("a violation of a race constraint counts as a stale snapshot", async ({ db }) => {
    await withClient(db, async (prisma) => {
      const event = {
        source: "csv",
        externalId: "row-1",
        receivedAt: new Date("2026-03-02T09:00:00.000Z"),
        raw: {},
        outcome: "rejectedNoEmail",
      } as const;
      await prisma.intakeEvent.create({ data: event });
      const error = await failureOf(prisma.intakeEvent.create({ data: event }));

      expect(error).toMatchObject({
        code: "P2002",
        meta: {
          driverAdapterError: {
            cause: { constraint: { index: "intake_events_source_external_id_key" } },
          },
        },
      });
      expect(isStaleSnapshot(error)).toBe(true);
    });
  });
});

describe("transact", () => {
  test("runs the body again on a fresh snapshot until it commits", async ({ db }) => {
    await withClient(db, async (prisma) => {
      const team = await prisma.team.create({ data: { name: "0", kind: "sales" } });
      let interfered = false;

      const seen = await transact(prisma, async (tx) => {
        const current = await tx.team.findUniqueOrThrow({ where: { id: team.id } });
        if (!interfered) {
          interfered = true;
          await prisma.team.update({ where: { id: team.id }, data: { name: "1" } });
        }
        await tx.team.update({ where: { id: team.id }, data: { name: `${current.name}+` } });
        return current.name;
      });

      expect(seen).toBe("1");
      expect(await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).toMatchObject({
        name: "1+",
      });
      expect(db.transactions).toEqual([{ attempts: 2, committed: true }]);
    });
  });

  test("gives up after ten attempts and throws the original error", async ({ db }) => {
    await withClient(db, async (prisma) => {
      const team = await prisma.team.create({ data: { name: "0", kind: "sales" } });
      let attempts = 0;

      const error = await failureOf(
        transact(prisma, async (tx) => {
          attempts += 1;
          await tx.team.findUniqueOrThrow({ where: { id: team.id } });
          await prisma.team.update({ where: { id: team.id }, data: { name: String(attempts) } });
          await tx.team.update({ where: { id: team.id }, data: { name: "never" } });
        }),
      );

      expect(attempts).toBe(10);
      expect(error).toMatchObject({ code: "P2034" });
      expect(db.transactions).toEqual([{ attempts: 10, committed: false }]);
    });
  });

  test("does not retry an error that is not a stale snapshot", async ({ db }) => {
    await withClient(db, async (prisma) => {
      let attempts = 0;
      const error = await failureOf(
        transact(prisma, () => {
          attempts += 1;
          return Promise.reject(new Error("a bug in the body"));
        }),
      );

      expect(attempts).toBe(1);
      expect(error).toMatchObject({ message: "a bug in the body" });
      expect(db.transactions).toEqual([{ attempts: 1, committed: false }]);
    });
  });
});

describe("race constraints", () => {
  test("every name is a unique index in the migrated schema", async ({ db }) => {
    const indexes = await db.rows(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexname = ANY($1)
       ORDER BY indexname`,
      [RACE_CONSTRAINTS],
    );
    expect(indexes.map((row) => row.indexname)).toEqual([...RACE_CONSTRAINTS].sort());
  });
});
