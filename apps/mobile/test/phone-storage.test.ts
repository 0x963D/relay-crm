import { afterEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { phoneStorage } from "../src/api/phone-storage.ts";
import { emptyPhone } from "../src/core/write-model.ts";
import { draft, id, scope } from "./write-fixtures.ts";

interface SQLiteProbe {
  db: DatabaseSync | null;
  failCommit: boolean;
}
const state = vi.hoisted((): SQLiteProbe => ({ db: null, failCommit: false }));
vi.mock("expo-sqlite", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  state.db = db;
  return {
    openDatabaseAsync: () =>
      Promise.resolve({
        execAsync: (sql: string) => {
          db.exec(sql);
          return Promise.resolve();
        },
        runAsync: (sql: string, ...values: string[]) =>
          Promise.resolve(db.prepare(sql).run(...values)),
        getFirstAsync: (sql: string, ...values: string[]) =>
          Promise.resolve(db.prepare(sql).get(...values)),
        withTransactionAsync: async (work: () => Promise<void>) => {
          db.exec("BEGIN IMMEDIATE");
          try {
            await work();
            if (state.failCommit) throw new Error("Commit failed.");
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        },
      }),
  };
});
afterEach(() => {
  state.failCommit = false;
});
it("uses full synchronization on the private connection", async () => {
  await phoneStorage.load(scope);
  expect(state.db?.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
  expect(state.db?.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "memory" });
});
it("commits a complete snapshot atomically and rolls back a failed commit", async () => {
  await phoneStorage.replace(scope, emptyPhone());
  const next = { ...emptyPhone(), drafts: { [JSON.stringify([id, "attempt"])]: draft } };
  state.failCommit = true;
  await expect(phoneStorage.replace(scope, next)).rejects.toThrow("Commit failed");
  expect(await phoneStorage.load(scope)).toEqual(emptyPhone());
  state.failCommit = false;
  await phoneStorage.replace(scope, next);
  expect(await phoneStorage.load(scope)).toEqual(next);
});
it("serializes transactions and deletes only the named owner", async () => {
  const other = { ...scope, person: "other" };
  await Promise.all([
    phoneStorage.replace(scope, emptyPhone()),
    phoneStorage.replace(other, emptyPhone()),
  ]);
  await phoneStorage.remove(scope);
  expect(await phoneStorage.load(scope)).toBeNull();
  expect(await phoneStorage.load(other)).toEqual(emptyPhone());
});
