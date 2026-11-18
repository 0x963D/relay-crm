import { openDatabaseAsync } from "expo-sqlite";
import { phoneSchema } from "../core/write-model.ts";
import type { PhoneStorage } from "../core/phone-entries.ts";

async function open() {
  const db = await openDatabaseAsync("relay-work-v1.db");
  await db.execAsync(
    "PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON; CREATE TABLE IF NOT EXISTS phone_work (server TEXT NOT NULL, person TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (server, person));",
  );
  return db;
}
let database: ReturnType<typeof open> | undefined;
let tail = Promise.resolve();
function connection() {
  database ??= open().catch((error: unknown) => {
    database = undefined;
    throw error;
  });
  return database;
}
function access<T>(work: (db: Awaited<ReturnType<typeof open>>) => Promise<T>) {
  const result = tail.then(async () => work(await connection()));
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
export const phoneStorage: PhoneStorage = {
  async load(scope) {
    return access(async (db) => {
      const row = await db.getFirstAsync<{ body: string }>(
        "SELECT body FROM phone_work WHERE server = ? AND person = ?",
        scope.server,
        scope.person,
      );
      return row ? phoneSchema.parse(JSON.parse(row.body)) : null;
    });
  },
  async replace(scope, data) {
    await access((db) =>
      db.withTransactionAsync(async () => {
        await db.runAsync(
          "INSERT INTO phone_work (server, person, body) VALUES (?, ?, ?) ON CONFLICT (server, person) DO UPDATE SET body = excluded.body",
          scope.server,
          scope.person,
          JSON.stringify(data),
        );
      }),
    );
  },
  async remove(scope) {
    await access((db) =>
      db.withTransactionAsync(async () => {
        await db.runAsync(
          "DELETE FROM phone_work WHERE server = ? AND person = ?",
          scope.server,
          scope.person,
        );
      }),
    );
  },
};
