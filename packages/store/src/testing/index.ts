import { test as base } from "vitest";
import { createTestDatabase, type TestDatabase } from "./database.ts";
export * from "./database.ts";
/**
 * Vitest's `test` with a `db` fixture, which is a fresh database that is dropped after the test.
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
