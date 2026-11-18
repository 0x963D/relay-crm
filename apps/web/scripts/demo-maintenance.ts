import { maintainDemo, recoverDemoSeed } from "../src/server/demo-maintenance.ts";
import { readDemoSetupEnv } from "../src/server/env.ts";
import { logToConsole, errorIdentity } from "../src/server/log.ts";

try {
  const { env, migrationUrl } = readDemoSetupEnv();
  if (!migrationUrl || !env.demo || env.email?.kind !== "disabled")
    throw new Error("Hosted maintenance requires its owner configuration and disabled email.");
  const seed = await recoverDemoSeed(env, migrationUrl);
  const day = await maintainDemo(env, migrationUrl);
  process.stdout.write(
    day.state === "reset"
      ? "Restored the demo for the local day.\n"
      : seed.changed
        ? "Demo setup is ready.\n"
        : "Demo data is current for the local day.\n",
  );
} catch (error) {
  logToConsole("demoMaintenance.failed", { error: errorIdentity(error) });
  process.exitCode = 1;
}
