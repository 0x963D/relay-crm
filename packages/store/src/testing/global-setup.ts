import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { testServer } from "./server.ts";

export default async function setup(): Promise<() => Promise<void>> {
  const server = testServer();
  await server.dropTestDatabases();
  const previousRun = process.env.RELAY_TEST_RUN;
  process.env.RELAY_TEST_RUN = `${String(process.pid)}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  // A detached process survives a Windows console interrupt and cleans only this run.
  const cleanup = fork(fileURLToPath(new URL("./cleanup.ts", import.meta.url)), [], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    execArgv: [],
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    cleanup.once("exit", resolve);
    cleanup.once("error", reject);
  });
  await Promise.race([
    once(cleanup, "message"),
    exited.then(() => {
      throw new Error("Test database cleanup did not start.");
    }),
  ]);
  let cleaning: Promise<void> | undefined;
  const teardown = () =>
    (cleaning ??= (async () => {
      cleanup.send("close");
      const code = await exited;
      if (previousRun === undefined) delete process.env.RELAY_TEST_RUN;
      else process.env.RELAY_TEST_RUN = previousRun;
      if (code !== 0) throw new Error("Test database cleanup failed.");
    })());
  try {
    await server.dropDatabase(server.templateName);
    await server.admin((client) =>
      client.query(`CREATE DATABASE ${pg.escapeIdentifier(server.templateName)}`),
    );
    const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
    await promisify(execFile)(process.execPath, [prismaCli, "migrate", "deploy"], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...process.env, MIGRATION_DATABASE_URL: server.ownerUrlFor(server.templateName) },
    });
    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}
