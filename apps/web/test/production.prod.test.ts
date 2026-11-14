import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const APP = fileURLToPath(new URL("..", import.meta.url));
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
async function serve(variables: Readonly<Record<string, string>>) {
  const port = await freePort();
  const inherited = Object.entries(process.env).filter(
    ([name]) => name !== "NODE_ENV" && name !== "DATABASE_URL" && !/^(META|RELAY)_/.test(name),
  );
  const server = spawn(process.execPath, [NEXT, "start", "--port", String(port)], {
    cwd: APP,
    env: { ...Object.fromEntries(inherited), DATABASE_URL: UNREACHABLE_DATABASE, ...variables },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  await new Promise<void>((resolve, reject) => {
    server.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Ready in")) resolve();
    });
    server.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    server.on("exit", (code) => {
      reject(new Error(`next start exited with ${String(code)} before it was ready:\n${output}`));
    });
  });

  return {
    url: (path: string) => `http://127.0.0.1:${String(port)}${path}`,
    stop: async () => {
      const exited = once(server, "exit");
      server.kill();
      await exited;
    },
  };
}

describe("the production server with no session", () => {
  test.for([
    ["no dev variables", {}],
    ["RELAY_DEV_ACTOR=1", { RELAY_DEV_ACTOR: "1" }],
    [
      "RELAY_DEV_ACTOR=1 and RELAY_DEV_ROLE=owner",
      { RELAY_DEV_ACTOR: "1", RELAY_DEV_ROLE: "owner" },
    ],
  ] as const)(
    "answers the lead list with 401 and the not-signed-in screen, with %s",
    async ([, variables]) => {
      const server = await serve(variables);
      try {
        const response = await fetch(server.url("/"));

        expect(response.status).toBe(401);
        expect(await response.text()).toContain("You are not signed in");
      } finally {
        await server.stop();
      }
    },
  );

  test("keeps both intake endpoints open, because neither needs an actor", async () => {
    const server = await serve({ RELAY_DEV_ACTOR: "1" });
    try {
      const form = await fetch(server.url("/api/intake/form"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "not an address" }),
      });
      const meta = await fetch(server.url("/api/intake/meta"));

      expect(form.status).toBe(422);
      expect(meta.status, "the webhook is off because no META_ variable is set").toBe(404);
    } finally {
      await server.stop();
    }
  });
});
