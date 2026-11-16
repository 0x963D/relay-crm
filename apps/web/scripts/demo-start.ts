import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { seedDemo } from "@relay/store/demo";
import { demoOptions, demoOwnerUrl } from "../src/server/demo.ts";
import { commandEnvironment, loadDemoConfiguration } from "../src/server/env.ts";

const env = await loadDemoConfiguration("/run/relay-secrets/app.json");
const ownerUrl = await demoOwnerUrl("/run/relay-secrets/owner.json");
const migration = await promisify(execFile)("pnpm", ["db:migrate"], {
  cwd: fileURLToPath(new URL("../../..", import.meta.url)),
  env: commandEnvironment({ MIGRATION_DATABASE_URL: ownerUrl }),
});
process.stdout.write(migration.stdout);
const seeded = await seedDemo(demoOptions(env, ownerUrl));
process.stdout.write(
  seeded.changed
    ? "Seeded Tidewell Language School.\n"
    : "Demo data already exists. Nothing changed.\n",
);
const server = spawn(process.execPath, ["scripts/serve.ts"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdio: "inherit",
});
process.on("SIGTERM", () => server.kill("SIGTERM"));
process.on("SIGINT", () => server.kill("SIGINT"));
server.on("error", (error) => {
  throw error;
});
server.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
