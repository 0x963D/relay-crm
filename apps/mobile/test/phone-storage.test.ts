import { afterEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { phoneStorage } from "../src/api/phone-storage.ts";
import { PhoneEntries } from "../src/core/phone-entries.ts";
import { erasePhone } from "../src/core/sign-out.ts";
import { emptyPhone } from "../src/core/write-model.ts";
import type { Command } from "../src/core/write-model.ts";
import { command, draft, flush, id, now, scope } from "./write-fixtures.ts";

interface SQLiteProbe {
  db: DatabaseSync | null;
  failCommit: boolean;
  beforeWrite?: () => Promise<void>;
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
            await state.beforeWrite?.();
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
  delete state.beforeWrite;
});
it("uses full synchronization on the private connection", async () => {
  await phoneStorage.load(scope);
  expect(state.db?.prepare("PRAGMA secure_delete").get()).toEqual({ secure_delete: 1 });
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

function phoneOwner(ownerScope = scope) {
  const dispatch = vi.fn<(_command: Command, signal: AbortSignal) => Promise<never>>(
    () => new Promise<never>(() => undefined),
  );
  const owner = new PhoneEntries({
    scope: ownerScope,
    storage: phoneStorage,
    identity: () => ownerScope,
    dispatch,
    now: () => now,
    reportError: vi.fn(),
  });
  return { owner, dispatch };
}

it("sign-out aborts the live owner and erases its row through the SQLite adapter", async () => {
  const ownScope = { ...scope, person: "sign-out" };
  const { owner, dispatch } = phoneOwner(ownScope);
  await owner.restore();
  await owner.save(command, draft, false);
  const signal = dispatch.mock.calls[0]?.[1];
  expect(signal?.aborted).toBe(false);
  await erasePhone(owner, phoneStorage, ownScope);
  expect(signal?.aborted).toBe(true);
  expect(await phoneStorage.load(ownScope)).toBeNull();
  await expect(owner.keepDraft(draft, id, "attempt")).rejects.toThrow("retired");
});

it("loads an in-flight store after its owner retires even without a same-scope predecessor", async () => {
  const ownScope = { ...scope, person: "ordering" };
  const { owner, dispatch } = phoneOwner(ownScope);
  await owner.restore();
  const gate = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<undefined>();
  state.beforeWrite = () => {
    delete state.beforeWrite;
    started.resolve(undefined);
    return gate.promise;
  };
  const saving = owner.save(command, draft, false);
  await started.promise;
  owner.retire();
  const next = phoneOwner(ownScope);
  const loaded = vi.fn();
  const restoring = next.owner.restore().then(loaded);
  await flush();
  const loadedBeforeStore = loaded.mock.calls.length;
  gate.resolve(undefined);
  await Promise.all([saving, restoring]);
  expect(loadedBeforeStore).toBe(0);
  expect(next.owner.snapshot(id)).toMatchObject({ state: "unknown", entry: { command } });
  expect(dispatch).not.toHaveBeenCalled();
});
