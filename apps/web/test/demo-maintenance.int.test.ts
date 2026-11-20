import { expect } from "vitest";
import { test, type TestDatabase } from "@relay/store/testing";
import { parseEnv } from "../src/server/env.ts";
import { maintainDemo, recoverDemoSeed } from "../src/server/demo-maintenance.ts";

const at = new Date("2031-07-15T16:30:00Z");
const envFor = (db: TestDatabase) =>
  parseEnv(
    {
      DATABASE_URL: db.connectionString,
      MIGRATION_DATABASE_URL: db.ownerConnectionString,
      NODE_ENV: "production",
      RELAY_DEMO: "1",
      RELAY_EMAIL_MODE: "disabled",
    },
    false,
    "maintenance",
  );

test("maintenance refuses a schema behind the checked-out code before writing", async ({ db }) => {
  await db.ownerRows("DELETE FROM _prisma_migrations WHERE migration_name='0009_native_sessions'");
  const before = await db.counts();
  await expect(recoverDemoSeed(envFor(db), db.ownerConnectionString, at)).rejects.toThrow(
    /not ready/,
  );
  expect(await db.counts()).toEqual(before);
  expect(await db.rows("SELECT * FROM demo_seed")).toEqual([]);
});

test(
  "maintenance recovers a building seed, leaves the same day alone, and resets on a new day",
  { timeout: 120_000 },
  async ({ db }) => {
    const env = envFor(db);
    const owner = db.ownerConnectionString;
    expect(await recoverDemoSeed(env, owner, at)).toMatchObject({ changed: true });
    await db.ownerRows("UPDATE demo_seed SET state='building'");
    expect(await db.store.demoReady()).toBe(false);
    expect(await recoverDemoSeed(env, owner, at)).toMatchObject({ changed: true });
    expect(await db.store.demoReady()).toBe(true);
    expect(await recoverDemoSeed(env, owner, at)).toMatchObject({ changed: false });
    await db.seedLead({
      email: "visitor@example.com",
      lifecycle: { state: { status: "new" }, firstAssignedAt: null, previousOwnerId: null },
    });
    const count = await db.counts();
    const next = new Date("2031-07-16T00:00:00Z");
    expect(await maintainDemo(env, owner, at)).toEqual({ state: "current", next });
    expect(await db.counts()).toEqual(count);
    expect(await maintainDemo(env, owner, next)).toEqual({ state: "reset" });
    expect(await db.rows("SELECT email FROM leads WHERE email='visitor@example.com'")).toEqual([]);
    expect(await db.rows("SELECT state FROM outbox WHERE state='sent'")).toEqual([]);
    expect(
      (await db.rows("SELECT state FROM outbox WHERE state='suppressed'")).length,
    ).toBeGreaterThan(0);
    expect(await db.store.demoReady()).toBe(true);
  },
);
