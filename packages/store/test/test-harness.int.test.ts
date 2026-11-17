import { expect, test } from "vitest";
import { spawn } from "node:child_process";
import pg from "pg";
import setup from "../src/testing/global-setup.ts";
import { testServer } from "../src/testing/server.ts";
import { test as databaseTest } from "../src/testing/index.ts";

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
  const stale =
    server.templateName.replace(/_template$/, "_test_") + crypto.randomUUID().replaceAll("-", "");
  await server.admin((client) => client.query(`CREATE DATABASE ${pg.escapeIdentifier(stale)}`));
  const teardown = await setup();
  try {
    expect(await names()).not.toContain(stale);
    const abandoned = testServer().newDatabaseName();
    await server.admin((client) =>
      client.query(`CREATE DATABASE ${pg.escapeIdentifier(abandoned)}`),
    );
    const connection = new pg.Client({ connectionString: server.urlFor(abandoned) });
    connection.on("error", () => undefined);
    await connection.connect();
    try {
      await teardown();
    } finally {
      await connection.end();
    }
    expect(await names()).toEqual(before);
  } finally {
    await teardown();
  }
});

test("a terminated runner leaves no database for its cleanup process", async () => {
  const source = `
    import setup from ${JSON.stringify(new URL("../src/testing/global-setup.ts", import.meta.url).href)};
    import { testServer } from ${JSON.stringify(new URL("../src/testing/server.ts", import.meta.url).href)};
    import pg from ${JSON.stringify(import.meta.resolve("pg"))};
    await setup();
    const server = testServer();
    const name = server.newDatabaseName();
    await server.admin(client => client.query('CREATE DATABASE ' + pg.escapeIdentifier(name)));
    process.send(name);
    setInterval(() => {}, 1000);
  `;
  const runner = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => {
    runner.once("exit", () => {
      resolve();
    });
  });
  try {
    const name = await new Promise<string>((resolve, reject) => {
      runner.once("error", reject);
      runner.once("message", (message) => {
        if (typeof message === "string") resolve(message);
        else reject(new Error("No database name"));
      });
      runner.once("exit", () => {
        reject(new Error("Runner exited before creating its database"));
      });
    });
    runner.kill("SIGKILL");
    await exited;
    await expect
      .poll(
        async () =>
          testServer().admin(
            async (client) =>
              (await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])).rowCount,
          ),
        { timeout: 5000 },
      )
      .toBe(0);
  } finally {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
    await exited;
  }
});

databaseTest("nested setup leaves a live fixture alone", async ({ db }) => {
  const teardown = await setup();
  try {
    expect(await db.rows("SELECT 1 AS live")).toEqual([{ live: 1 }]);
  } finally {
    await teardown();
  }
});
