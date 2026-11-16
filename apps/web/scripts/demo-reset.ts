import { resetDemo } from "@relay/store/demo";
import { readDemoSetupEnv } from "../src/server/env.ts";
import { demoOptions, demoOwnerUrl } from "../src/server/demo.ts";

const { env, migrationUrl } = readDemoSetupEnv();
if (!env.demo) throw new Error("Demo reset requires RELAY_DEMO=1.");
const ownerUrl = migrationUrl ?? (env.demoOwnerFile ? await demoOwnerUrl(env.demoOwnerFile) : null);
if (!ownerUrl) throw new Error("Demo reset requires the owner connection.");
await resetDemo({ ...demoOptions(env, ownerUrl), demo: env.demo });
process.stdout.write("Restored Tidewell Language School. All sessions ended.\n");
