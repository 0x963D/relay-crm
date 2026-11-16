import { expect } from "vitest";
import { openStore } from "../src/index.ts";
import { test } from "../src/testing/index.ts";

const latch = (): PromiseWithResolvers<void> => Promise.withResolvers();

test("job locks exclude other connections on the same route and allow the other route", async ({
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
