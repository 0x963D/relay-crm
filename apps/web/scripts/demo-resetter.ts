import { setTimeout as sleep } from "node:timers/promises";
import { seedDemo } from "@relay/store/demo";
import { deployMigrations } from "@relay/store/migrate";
import { maintainDemo } from "../src/server/demo-maintenance.ts";
import { demoOptions } from "../src/server/demo.ts";
import { loadDemoConfiguration, readDemoSetupEnv, commandEnvironment } from "../src/server/env.ts";

await loadDemoConfiguration("/run/relay-secrets/reset/config.json");
const { env, migrationUrl } = readDemoSetupEnv();
if (!migrationUrl || !env.demo)
  throw new Error("Demo maintenance requires its owner configuration.");
await deployMigrations(commandEnvironment({ MIGRATION_DATABASE_URL: migrationUrl }));
for (;;) {
  try {
    await seedDemo(demoOptions(env, migrationUrl));
    break;
  } catch {
    process.stderr.write("Demo setup has not finished. Retrying in five seconds.\n");
    await sleep(5000);
  }
}
process.stdout.write("Demo setup is ready.\n");
for (;;) {
  try {
    const result = await maintainDemo(env, migrationUrl);
    if (result.state === "reset") {
      process.stdout.write("Restored the demo for the local day.\n");
    } else {
      await sleep(Math.max(1, result.next.getTime() - Date.now()));
    }
  } catch {
    process.stderr.write("Demo reset failed. Retrying in five seconds.\n");
    await sleep(5000);
  }
}
