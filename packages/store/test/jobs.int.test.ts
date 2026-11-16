import { expect, vi } from "vitest";
import { openStore } from "../src/index.ts";
import { test } from "../src/testing/index.ts";

const latch = (): PromiseWithResolvers<void> => Promise.withResolvers();

test("job leases exclude other connections on the same route and allow the other route", async ({
  db,
}) => {
  const other = openStore({ connectionString: db.connectionString });
  const entered = latch();
  const release = latch();
  const first = db.store.exclusiveJob("outbox", async () => {
    entered.resolve();
    await release.promise;
    return "done";
  });
  await entered.promise;
  try {
    expect(
      await db.rows(
        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND xact_start IS NOT NULL",
      ),
    ).toEqual([]);
    expect(await other.exclusiveJob("outbox", () => Promise.resolve("overlap"))).toEqual({
      ran: false,
    });
    expect(await other.exclusiveJob("reconcile", () => Promise.resolve("separate"))).toEqual({
      ran: true,
      result: "separate",
    });
  } finally {
    release.resolve();
    await first;
  }
  expect(await other.exclusiveJob("outbox", () => Promise.resolve("next"))).toEqual({
    ran: true,
    result: "next",
  });
  await other.close();
});

test("an expired job lease recovers and a superseded caller cannot release its replacement", async ({
  db,
}) => {
  const firstRelease = latch();
  const firstEntered = latch();
  const secondRelease = latch();
  const secondEntered = latch();
  const first = db.store.exclusiveJob("reconcile", async () => {
    firstEntered.resolve();
    await firstRelease.promise;
  });
  await firstEntered.promise;
  await db.rows(
    "UPDATE job_leases SET expires_at=now()-interval '1 second' WHERE route='reconcile'",
  );
  const second = db.store.exclusiveJob("reconcile", async () => {
    secondEntered.resolve();
    await secondRelease.promise;
  });
  await secondEntered.promise;
  try {
    firstRelease.resolve();
    await first;
    expect(await db.store.exclusiveJob("reconcile", () => Promise.resolve())).toEqual({
      ran: false,
    });
    const [lease] = await db.rows(
      "SELECT extract(epoch FROM expires_at-now())::int AS seconds FROM job_leases WHERE route='reconcile'",
    );
    expect(lease?.seconds).toBeGreaterThan(0);
    expect(lease?.seconds).toBeLessThanOrEqual(15);
  } finally {
    firstRelease.resolve();
    secondRelease.resolve();
    await Promise.all([first, second]);
  }
});

test("the app cannot create or read a demo job lease", async ({ db }) => {
  await expect(
    db.rows(
      "INSERT INTO job_leases(route,token,expires_at) VALUES ('demo',gen_random_uuid(),now()+interval '1 minute')",
    ),
  ).rejects.toMatchObject({ code: "42501" });
  await db.ownerRows(
    "INSERT INTO job_leases(route,token,expires_at) VALUES ('demo',gen_random_uuid(),now()+interval '1 minute')",
  );
  expect(await db.rows("SELECT * FROM job_leases WHERE route='demo'")).toEqual([]);
});

test("a running outbox job renews its short lease using the database clock", async ({ db }) => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const entered = latch();
  const release = latch();
  const running = db.store.exclusiveJob("outbox", async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  try {
    const [before] = await db.rows(
      "SELECT extract(epoch FROM expires_at)::double precision AS expiry,extract(epoch FROM expires_at-clock_timestamp()) AS seconds FROM job_leases WHERE route='outbox'",
    );
    expect(Number(before?.seconds)).toBeLessThanOrEqual(60);
    await vi.advanceTimersByTimeAsync(20000);
    await vi.waitFor(async () => {
      const [after] = await db.rows(
        "SELECT extract(epoch FROM expires_at)::double precision AS expiry FROM job_leases WHERE route='outbox'",
      );
      expect(Number(after?.expiry)).toBeGreaterThan(Number(before?.expiry));
    });
  } finally {
    release.resolve();
    await running;
    vi.useRealTimers();
  }
});

test("losing renewal aborts the running job and preserves the replacement token", async ({
  db,
}) => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const entered = latch();
  const running = db.store.exclusiveJob("outbox", async (signal) => {
    entered.resolve();
    await new Promise<void>((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          resolve();
        },
        { once: true },
      );
    });
  });
  const failed = expect(running).rejects.toThrow("lease was lost");
  try {
    await entered.promise;
    await db.ownerRows("UPDATE job_leases SET token=gen_random_uuid() WHERE route='outbox'");
    await vi.advanceTimersByTimeAsync(20000);
    await failed;
    expect(await db.store.exclusiveJob("outbox", () => Promise.resolve())).toEqual({ ran: false });
  } finally {
    vi.useRealTimers();
  }
});
