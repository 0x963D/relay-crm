import { setTimeout as sleep } from "node:timers/promises";
import { test as databaseTest } from "@relay/store/testing";
import { openSmtpInbox } from "./support/smtp.ts";
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
async function serve(
  variables:
    Readonly<Record<string, string>> | ((origin: string) => Readonly<Record<string, string>>),
  databaseUrl = UNREACHABLE_DATABASE,
) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const configured = typeof variables === "function" ? variables(origin) : variables;
  const inherited = Object.entries(process.env).filter(
    ([name]) =>
      name !== "NODE_ENV" && name !== "DATABASE_URL" && !/^(META|RELAY|AUTH|SMTP)_/.test(name),
  );
  const server = spawn(process.execPath, [NEXT, "start", "--port", String(port)], {
    cwd: APP,
    env: { ...Object.fromEntries(inherited), DATABASE_URL: databaseUrl, ...configured },
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
    output: () => output,
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

databaseTest(
  "a page-created store returns typed scope errors through the production API",
  async ({ db }) => {
    const userId = await db.seedUser("agent");
    const otherId = await db.seedUser("agent");
    const teamId = await db.seedTeam("sales");
    const id = await db.seedLead({
      email: "outside@example.com",
      lifecycle: {
        state: { status: "assigned", assignee: { ownerId: otherId, teamId } },
        firstAssignedAt: new Date(),
        previousOwnerId: null,
      },
    });
    const inbox = await openSmtpInbox();
    const server = await serve(
      (origin) => ({
        AUTH_URL: origin,
        AUTH_SECRET: "fake-production-test-secret-at-least-thirty-two-characters",
        SMTP_URL: inbox.url,
        SMTP_FROM: "relay@sender.example",
      }),
      db.connectionString,
    );
    try {
      expect((await fetch(server.url("/"))).status).toBe(401);
      const origin = new URL(server.url("/")).origin;
      const post = (path: string, body: unknown, cookie = "") =>
        fetch(server.url(path), {
          method: "POST",
          headers: { origin, "content-type": "application/json", cookie },
          body: JSON.stringify(body),
        });
      expect(
        (
          await post("/api/auth/email-otp/send-verification-otp", {
            email: "user-1@team.example",
            type: "sign-in",
          })
        ).status,
      ).toBe(200);
      for (let attempt = 0; attempt < 100 && inbox.messages.length === 0; attempt += 1)
        await sleep(50);
      const code = inbox.messages[0]?.match(/Your sign-in code is (\d{6})/)?.[1];
      if (!code) throw new Error("SMTP did not receive an issued code");
      const signed = await post("/api/auth/sign-in/email-otp", {
        email: "user-1@team.example",
        otp: code,
      });
      expect(signed.status).toBe(200);
      const cookie = signed.headers
        .getSetCookie()
        .find((value) => value.includes("relay.session_token="))
        ?.split(";")[0];
      if (!cookie) throw new Error("Sign-in issued no session cookie");
      const input = encodeURIComponent(JSON.stringify({ json: { id } }));
      const denied = await fetch(server.url(`/api/trpc/leads.get?input=${input}`), {
        headers: { cookie },
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({
        error: { json: { data: { code: "FORBIDDEN", accessFailure: "accessDenied" } } },
      });
      const assigning = await post(
        "/api/trpc/leads.assign",
        { json: { leadIds: [id], to: { ownerId: userId, teamId } } },
        cookie,
      );
      expect(assigning.status).toBe(403);
      expect(await assigning.json()).toMatchObject({
        error: { json: { data: { accessFailure: "accessDenied" } } },
      });
      expect(server.output()).not.toContain(code);
    } finally {
      await server.stop();
      await inbox.close();
    }
  },
);
