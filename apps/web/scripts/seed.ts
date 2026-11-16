import { seedDemo } from "@relay/store/demo";
import { readDemoSetupEnv } from "../src/server/env.ts";
import { demoOptions, demoOwnerUrl } from "../src/server/demo.ts";

const { env, migrationUrl } = readDemoSetupEnv();
const ownerUrl = migrationUrl ?? (env.demoOwnerFile ? await demoOwnerUrl(env.demoOwnerFile) : null);
if (!ownerUrl) throw new Error("Seed requires MIGRATION_DATABASE_URL or RELAY_DEMO_OWNER_FILE.");
const result = await seedDemo(demoOptions(env, ownerUrl));
process.stdout.write(
  result.changed
    ? "Seeded Tidewell Language School.\n"
    : "Demo data already exists. Nothing changed.\n",
);
