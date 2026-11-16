import { expect } from "vitest";
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
    expect(lease?.seconds).toBeGreaterThan(3500);
    expect(lease?.seconds).toBeLessThanOrEqual(3600);
  } finally {
    firstRelease.resolve();
    secondRelease.resolve();
    await Promise.all([first, second]);
  }
});
