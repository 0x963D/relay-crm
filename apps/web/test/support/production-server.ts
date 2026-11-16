import { spawn } from "node:child_process";
import { commandEnvironment } from "../../src/server/env.ts";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
const APP = fileURLToPath(new URL("../..", import.meta.url));
const NEXT = createRequire(import.meta.url).resolve("next/dist/bin/next");
const UNREACHABLE_DATABASE = "postgresql://nobody:nobody@127.0.0.1:9/unreachable";
async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  probe.close();
  await once(probe, "close");
  if (address === null || typeof address === "string") throw new Error("No TCP port was bound");
  return address.port;
}

/**
 * NODE_ENV is left for Next to set, so the server runs as production and not as the test runner's
 * "test".
 */
export async function serve(
  variables:
    Readonly<Record<string, string>> | ((origin: string) => Readonly<Record<string, string>>),
  databaseUrl = UNREACHABLE_DATABASE,
  rawNext = false,
) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const configured = typeof variables === "function" ? variables(origin) : variables;
  const inherited = Object.entries(commandEnvironment({})).filter(
    ([name]) =>
      name !== "NODE_ENV" &&
      name !== "DATABASE_URL" &&
      name !== "MIGRATION_DATABASE_URL" &&
      !/^(META|RELAY|AUTH|SMTP)_/.test(name),
  );
  const server = spawn(
    process.execPath,
    rawNext ? [NEXT, "start", "--port", String(port)] : ["scripts/serve.ts"],
    {
      cwd: APP,
      env: {
        ...Object.fromEntries(inherited),
        DATABASE_URL: databaseUrl,
        PORT: String(port),
        HOST: "127.0.0.1",
        ...configured,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  await new Promise<void>((resolve, reject) => {
    server.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Ready in") && rawNext) resolve();
    });
    server.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("server.ready")) resolve();
    });
    server.on("exit", (code) => {
      reject(new Error(`next start exited with ${String(code)} before it was ready:\n${output}`));
    });
  });

  return {
    output: () => output,
    url: (path: string) => `http://127.0.0.1:${String(port)}${path}`,
    stop: async () => {
      if (server.exitCode !== null || server.signalCode !== null) return;
      const exited = once(server, "exit");
      server.kill();
      await exited;
    },
  };
}
