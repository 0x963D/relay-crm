import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { testServer } from "./server.ts";

export default async function setup(): Promise<void> {
  const server = testServer();
  const template = pg.escapeIdentifier(server.templateName);
  await server.dropDatabase(server.templateName);
  await server.admin((client) => client.query(`CREATE DATABASE ${template}`));

  const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");
  await promisify(execFile)(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { ...process.env, MIGRATION_DATABASE_URL: server.ownerUrlFor(server.templateName) },
  });
}
