import { expect, test } from "vitest";
import pg from "pg";
import setup from "../src/testing/global-setup.ts";
import { testServer } from "../src/testing/server.ts";

test("a run removes stale test databases on entry and abandoned databases on exit", async () => {
  const server = testServer();
  const names = async () =>
    server.admin(async (client) =>
      (
        await client.query<{ name: string }>(
          "SELECT datname AS name FROM pg_database ORDER BY datname",
        )
      ).rows.map((row) => row.name),
    );
  const before = await names();
  const stale = server.newDatabaseName();
  await server.admin((client) => client.query(`CREATE DATABASE ${pg.escapeIdentifier(stale)}`));
  const teardown = await setup();
  try {
    expect(await names()).not.toContain(stale);
    const abandoned = testServer().newDatabaseName();
    await server.admin((client) =>
      client.query(`CREATE DATABASE ${pg.escapeIdentifier(abandoned)}`),
    );
    await teardown();
    expect(await names()).toEqual(before);
  } finally {
    await teardown?.();
  }
});
