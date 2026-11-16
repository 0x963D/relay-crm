import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { seedDemo, resetDemo, demoSchedule } from "@relay/store/demo";
import { demoOptions } from "../src/server/demo.ts";
import { loadDemoConfiguration, readDemoSetupEnv, commandEnvironment } from "../src/server/env.ts";

await loadDemoConfiguration("/run/relay-secrets/reset/config.json");
const { env, migrationUrl } = readDemoSetupEnv();
if (!migrationUrl || !env.demo)
  throw new Error("Demo maintenance requires its owner configuration.");
const migration = await promisify(execFile)("pnpm", ["db:migrate"], {
  cwd: fileURLToPath(new URL("../../..", import.meta.url)),
  env: commandEnvironment({ MIGRATION_DATABASE_URL: migrationUrl }),
});
process.stdout.write(migration.stdout);
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
    const schedule = await demoSchedule(migrationUrl, env.timeZone);
    if (schedule.seededAt < schedule.start) {
      await resetDemo({ ...demoOptions(env, migrationUrl), demo: true });
      process.stdout.write("Restored the demo for the local day.\n");
    } else {
      await sleep(Math.max(1, schedule.next.getTime() - Date.now()));
    }
  } catch {
    process.stderr.write("Demo reset failed. Retrying in five seconds.\n");
    await sleep(5000);
  }
}
