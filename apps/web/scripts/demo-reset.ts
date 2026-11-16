import { resetDemo } from "@relay/store/demo";
import { readDemoSetupEnv, loadDemoConfiguration } from "../src/server/env.ts";
import { demoOptions } from "../src/server/demo.ts";

if (process.argv.includes("--container"))
  await loadDemoConfiguration("/run/relay-secrets/reset/config.json");

const { env, migrationUrl } = readDemoSetupEnv();
if (!env.demo) throw new Error("Demo reset requires RELAY_DEMO=1.");
const ownerUrl = migrationUrl;
if (!ownerUrl) throw new Error("Demo reset requires the owner connection.");
await resetDemo({ ...demoOptions(env, ownerUrl), demo: env.demo });
process.stdout.write("Restored Tidewell Language School. All sessions ended.\n");
