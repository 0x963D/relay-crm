import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { openStore } from "@relay/store";
import { loadDemoConfiguration } from "../src/server/env.ts";

const env = await loadDemoConfiguration("/run/relay-secrets/app/config.json");
const store = openStore({ connectionString: env.databaseUrl });
try {
  for (;;) {
    try {
      if ((await store.databaseReady()) && (await store.demoReady())) break;
    } catch {
      process.stdout.write("Waiting for demo setup.\n");
    }
    await sleep(1000);
  }
} finally {
  await store.close();
}
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
