import { seedDemo } from "@relay/store/demo";
import { readDemoSetupEnv } from "../src/server/env.ts";
import { demoOptions } from "../src/server/demo.ts";

const { env, migrationUrl } = readDemoSetupEnv();
const ownerUrl = migrationUrl;
if (!ownerUrl) throw new Error("Seed requires MIGRATION_DATABASE_URL.");
const result = await seedDemo(demoOptions(env, ownerUrl));
process.stdout.write(
  result.changed
    ? "Seeded Tidewell Language School.\n"
    : "Demo data already exists. Nothing changed.\n",
);
