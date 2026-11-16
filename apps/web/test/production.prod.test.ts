import { randomUUID } from "node:crypto";
import { signPaymentBody } from "../src/server/payments/webhook.ts";
import superjson from "superjson";
import { z } from "zod";
import { setTimeout as sleep } from "node:timers/promises";
import { test as databaseTest } from "@relay/store/testing";
import { openSmtpInbox } from "./support/smtp.ts";
import { spawn, exec } from "node:child_process";
import { promisify } from "node:util";
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
  rawNext = false,
) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const configured = typeof variables === "function" ? variables(origin) : variables;
  const inherited = Object.entries(process.env).filter(
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

describe("the production server with no session", () => {
  test("answers the lead list and RPC with 401 without a session", async () => {
    const server = await serve({});
    try {
      const response = await fetch(server.url("/"));
      expect(response.status).toBe(401);
      expect(await response.text()).toContain("You are not signed in");
      expect(
        (await fetch(server.url("/api/trpc/leads.list?input=%7B%22json%22%3A%7B%7D%7D"))).status,
      ).toBe(401);
    } finally {
      await server.stop();
    }
  });

  databaseTest(
    "keeps both intake endpoints open, because neither needs an actor",
    async ({ db }) => {
      const server = await serve({}, db.connectionString);
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
    },
  );
});

databaseTest(
  "a second client signs in while the first is limited, and typed scope errors survive production",
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
        RELAY_TRUSTED_PROXY_COUNT: "1",
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
      const post = (path: string, body: unknown, cookie = "", client = "192.0.2.2") =>
        fetch(server.url(path), {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            cookie,
            "x-forwarded-for": client,
          },
          body: JSON.stringify(body),
        });
      for (let i = 0; i < 20; i += 1) {
        const result = await post(
          "/api/auth/email-otp/send-verification-otp",
          { email: `attacker-${String(i)}@example.com`, type: "sign-in" },
          "",
          "192.0.2.1",
        );
        expect(result.status).toBe(200);
      }
      const refusals = [];
      for (const email of ["user-1@team.example", "unknown@example.com"]) {
        const refused = await post(
          "/api/auth/email-otp/send-verification-otp",
          { email, type: "sign-in" },
          "",
          "192.0.2.1",
        );
        expect(refused.status).toBe(429);
        expect(refused.headers.get("retry-after")).toBe("60");
        refusals.push(await refused.json());
      }
      expect(refusals[0]).toEqual(refusals[1]);
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
      for (const path of [
        "/api/auth/email-otp/send-verification-otp",
        "/api/auth/sign-out",
        "/api/trpc/leads.edit",
        "/api/intake/form",
      ]) {
        const oversized = await post(path, { pad: "x".repeat(2_000_000) }, cookie);
        expect(oversized.status).toBe(413);
      }
      const editable = await db.seedLead({
        email: "editable@example.com",
        lifecycle: {
          state: { status: "assigned", assignee: { ownerId: userId, teamId } },
          firstAssignedAt: new Date(),
          previousOwnerId: null,
        },
      });
      await db.ownerRows(`CREATE FUNCTION force_internal_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'database password leaked in this message'; END $$;
        CREATE TRIGGER force_edit_failure BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION force_internal_failure();`);
      const broken = await post(
        "/api/trpc/leads.edit",
        { json: { id: editable, name: "New name", phone: null } },
        cookie,
      );
      expect(broken.status).toBe(500);
      const internalBody = await broken.text();
      expect(internalBody).toContain("Something went wrong.");
      expect(internalBody).not.toContain("database password leaked in this message");
      const requestId = /"requestId":"([^"]+)"/.exec(internalBody)?.[1];
      if (!requestId) throw new Error("Internal error returned no request ID");
      expect(server.output()).toContain(requestId);
      expect(server.output()).toContain("database password leaked in this message");
      await db.ownerRows(
        "CREATE TRIGGER force_limit_failure BEFORE INSERT OR UPDATE ON auth_request_limits FOR EACH ROW EXECUTE FUNCTION force_internal_failure()",
      );
      for (const path of ["/api/auth/email-otp/send-verification-otp", "/api/intake/form"]) {
        const failed = await post(path, { email: "failure@example.com", type: "sign-in" });
        expect(failed.status).toBe(500);
        const body = await failed.text();
        expect(body).toContain("Something went wrong.");
        expect(body).not.toContain("database password leaked in this message");
        const id = /"requestId":"([^"]+)"/.exec(body)?.[1];
        if (!id) throw new Error("HTTP failure returned no request ID");
        expect(server.output()).toContain(id);
      }
      expect(server.output()).not.toContain(code);
    } finally {
      await server.stop();
      await inbox.close();
    }
  },
);

databaseTest(
  "refuses the development owner in a production build even with runtime development variables",
  async ({ db }) => {
    const attempt = serve(
      { NODE_ENV: "development", RELAY_DEV_ACTOR: "1", RELAY_DEV_ROLE: "owner" },
      db.connectionString,
      true,
    ).then(async (server) => {
      try {
        const response = await fetch(server.url("/")).catch(() => {
          throw new Error(server.output());
        });
        expect(response.status).toBe(401);
      } finally {
        await server.stop();
      }
    });
    await expect(attempt).rejects.toThrow(/RELAY_DEV_ACTOR.*production/);
    expect(await db.rows("SELECT email FROM users")).toEqual([]);
  },
);

databaseTest(
  "two production servers share form limits and ignore spoofed forwarded headers",
  async ({ db }) => {
    const server = await serve({}, db.connectionString);
    let second: Awaited<ReturnType<typeof serve>> | undefined;
    try {
      second = await serve({}, db.connectionString);
      for (let i = 0; i < 10; i += 1) {
        const response = await fetch((i % 2 === 0 ? server : second).url("/api/intake/form"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://other.example",
            "x-forwarded-for": `192.0.2.${String(i + 1)}`,
          },
          body: JSON.stringify({ email: `live-${String(i)}@example.com` }),
        });
        expect(response.status).toBe(202);
      }
      const refused = await fetch(second.url("/api/intake/form"), { method: "POST", body: "{}" });
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("60");
      expect((await db.counts()).leads).toBe(10);
    } finally {
      await second?.stop();
      await server.stop();
    }
  },
);

databaseTest(
  "production startup refuses repeated-letter and example auth secrets",
  async ({ db }) => {
    for (const secret of ["a".repeat(32), "example-only-do-not-use-this-secret"]) {
      await expect(
        serve((origin) => ({ AUTH_URL: origin, AUTH_SECRET: secret }), db.connectionString),
      ).rejects.toThrow(/AUTH_SECRET/);
    }
    expect(await db.rows("SELECT email FROM users")).toEqual([]);
  },
);

databaseTest(
  "live payments reconcile cards, approve manual receipts and deliver through SMTP",
  async ({ db }) => {
    const userId = await db.seedUser("agent");
    await db.seedUser("accountant");
    await db.seedUser("manager");
    await db.seedUser("manager");
    await db.seedUser("owner");
    const teamId = await db.seedTeam("sales");
    const accountId = await db.seedAccount();
    await db.rows("UPDATE accounts SET owner_id=$1 WHERE id=$2", [userId, accountId]);
    await db.seedLead({
      email: "customer@example.com",
      lifecycle: {
        state: { status: "won", accountId, assignee: { ownerId: userId, teamId } },
        firstAssignedAt: new Date(),
        previousOwnerId: null,
      },
    });
    let receiptOutcome: "sent" | "failed" | "unknown" = "sent";
    const inbox = await openSmtpInbox((message) =>
      message.includes("Subject: Your Relay payment receipt") ? receiptOutcome : "sent",
    );
    const outboxSecret = "fake-live-outbox-secret-for-production-tests";
    const reconcileSecret = "fake-live-reconcile-secret-for-production-tests";
    const server = await serve(
      (origin) => ({
        AUTH_URL: origin,
        AUTH_SECRET: "fake-production-payment-auth-secret-for-tests",
        SMTP_URL: inbox.url,
        SMTP_FROM: "relay@sender.example",
        RELAY_SANDBOX: "1",
        RELAY_DEMO: "1",
        RELAY_SANDBOX_URL: origin,
        RELAY_PAYMENT_WEBHOOK_SECRET: "fake-production-webhook-secret-for-tests",
        RELAY_RECONCILE_SECRET: reconcileSecret,
        RELAY_OUTBOX_SECRET: outboxSecret,
        RELAY_RECEIPT_LIFETIME_ATTEMPTS: "2",
        RELAY_RECONCILE_FIRST_MS: "0",
        RELAY_RECONCILE_INTERVAL_MS: "1000",
        RELAY_SANDBOX_LATE_MS: "2500",
      }),
      db.connectionString,
    );
    try {
      const origin = new URL(server.url("/")).origin;
      const post = (path: string, body: unknown, cookie = "") =>
        fetch(server.url(path), {
          method: "POST",
          headers: { origin, "content-type": "application/json", cookie },
          body: JSON.stringify(body),
        });
      const signIn = async (email: string) => {
        const count = inbox.messages.length;
        expect(
          (await post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" }))
            .status,
        ).toBe(200);
        for (let i = 0; i < 100 && inbox.messages.length === count; i += 1) await sleep(50);
        const otp = inbox.messages[count]?.match(/Your sign-in code is (\d{6})/)?.[1];
        if (!otp) throw new Error("No sign-in code arrived");
        const response = await post("/api/auth/sign-in/email-otp", { email, otp });
        expect(response.status).toBe(200);
        const cookie = response.headers
          .getSetCookie()
          .find((v) => v.includes("relay.session_token="))
          ?.split(";")[0];
        if (!cookie) throw new Error("No session cookie");
        return cookie;
      };
      const agent = await signIn("user-1@team.example");
      const accountant = await signIn("user-2@team.example");
      const manager = await signIn("user-3@team.example");
      const editor = await signIn("user-4@team.example");
      const owner = await signIn("user-5@team.example");
      const rpc = async (
        path: string,
        input: unknown,
        cookie: string,
        mutation = false,
      ): Promise<unknown> => {
        const response = mutation
          ? await post(`/api/trpc/${path}`, { json: input }, cookie)
          : await fetch(
              server.url(
                `/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
              ),
              { headers: { cookie } },
            );
        const raw: unknown = await response.json();
        expect(response.status, JSON.stringify(raw)).toBe(200);
        const envelope = z.object({ result: z.object({ data: z.unknown() }) }).parse(raw);
        return superjson.parse(JSON.stringify(envelope.result.data));
      };
      const Detail = z.object({
        demo: z.literal(true),
        id: z.string(),
        state: z.object({ status: z.string(), reason: z.string().optional() }),
        events: z.array(
          z.object({
            sequence: z.bigint(),
            kind: z.string(),
            at: z.date(),
            detail: z.record(z.string(), z.unknown()),
          }),
        ),
        posting: z
          .object({
            id: z.string(),
            lines: z.array(
              z.object({
                side: z.enum(["credit", "debit"]),
                amount: z.bigint(),
                account: z.object({ kind: z.string(), currency: z.string() }),
              }),
            ),
          })
          .nullable(),
      });
      const Ledger = z.object({
        balances: z.array(z.object({ currency: z.string(), balance: z.bigint() })),
      });
      expect((await fetch(server.url("/api/payments/reconcile"), { method: "POST" })).status).toBe(
        401,
      );
      let expectedBalance = 0n;
      for (const mode of ["late", "twice", "differentAmount"] as const) {
        const created = z
          .object({ paymentId: z.string(), checkout: z.object({ url: z.string() }) })
          .parse(
            await rpc(
              "payments.createCheckout",
              { key: mode, accountId, amount: "39500", currency: "GBP", kind: "repeat", mode },
              agent,
              true,
            ),
          );
        const anonymous = await fetch(server.url(`/sandbox/checkout/${created.paymentId}`), {
          method: "POST",
          headers: { origin },
          redirect: "manual",
        });
        expect(anonymous.status).toBe(404);
        const page = await fetch(created.checkout.url);
        const html = await page.text();
        expect(page.status).toBe(200);
        expect(html).toContain("Sandbox checkout");
        expect(html).toContain("Pay in sandbox");
        const paid = await fetch(created.checkout.url, {
          method: "POST",
          headers: { origin },
          redirect: "manual",
        });
        expect(paid.status).toBe(303);
        if (mode === "late") {
          const before = Detail.parse(
            await rpc("payments.get", { id: created.paymentId }, accountant),
          );
          expect(before.state.status).toBe("checkoutCreated");
          expect(before.posting).toBeNull();
          const run = await fetch(server.url("/api/payments/reconcile"), {
            method: "POST",
            headers: { authorization: `Bearer ${reconcileSecret}` },
          });
          expect(run.status).toBe(200);
          expect(await run.json()).toEqual({ checked: 1, changed: 1 });
        }
        let detail = Detail.parse(await rpc("payments.get", { id: created.paymentId }, accountant));
        const deliveries = mode === "twice" ? 2 : 1;
        for (
          let i = 0;
          i < 100 && detail.events.filter((e) => e.kind === "webhookDelivery").length < deliveries;
          i += 1
        ) {
          await sleep(50);
          detail = Detail.parse(await rpc("payments.get", { id: created.paymentId }, accountant));
        }
        expect(detail.events.filter((e) => e.kind === "webhookDelivery")).toHaveLength(deliveries);
        expect(detail.state.status).toBe(mode === "differentAmount" ? "needsReview" : "completed");
        if (mode === "differentAmount") expect(detail.posting).toBeNull();
        else {
          expectedBalance += 39500n;
          expect(detail.posting?.lines.map((l) => l.amount)).toEqual([39500n, 39500n]);
        }
        if (mode === "late") {
          expect(detail.events.map((e) => e.kind)).toEqual([
            "checkoutCreated",
            "reconcilerCheck",
            "settlement",
            "webhookDelivery",
          ]);
          expect(detail.events.find((e) => e.kind === "settlement")?.detail.by).toBe("reconciler");
          expect(detail.events.find((e) => e.kind === "webhookDelivery")?.detail).toMatchObject({
            late: true,
            changed: false,
          });
        }
        if (mode === "twice")
          expect(
            detail.events.filter((e) => e.kind === "webhookDelivery")[1]?.detail,
          ).toMatchObject({ duplicate: true, changed: false });
        const ownResponse = await rpc("payments.get", { id: created.paymentId }, agent);
        expect(ownResponse).not.toHaveProperty("checkoutPath");
        const own = Detail.parse(ownResponse);
        expect(own.posting).toBeNull();
        const ledger = Ledger.parse(await rpc("accounts.ledger", { id: accountId }, accountant));
        expect(ledger.balances).toEqual([{ currency: "GBP", balance: expectedBalance }]);
        process.stdout.write(
          `LIVE_PAYMENT ${JSON.stringify({ mode, detail, ledger }, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}\n`,
        );
      }
      const checkout = async (key: string) =>
        z
          .object({
            demo: z.literal(true),
            paymentId: z.string(),
            checkout: z.object({ url: z.string() }),
          })
          .parse(
            await rpc(
              "payments.createCheckout",
              { key, accountId, amount: "100", currency: "GBP", kind: "repeat", mode: "drop" },
              agent,
              true,
            ),
          );
      const closed = await checkout("expired-before-paid");
      const report = async (status: "expired" | "completed") => {
        const body = new TextEncoder().encode(
          JSON.stringify({
            eventId: randomUUID(),
            paymentId: closed.paymentId,
            status,
            amount: "100",
            currency: "GBP",
          }),
        );
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const response = await fetch(server.url("/api/payments/webhook"), {
          method: "POST",
          body,
          headers: {
            "x-sandbox-timestamp": timestamp,
            "x-sandbox-signature": signPaymentBody(
              "fake-production-webhook-secret-for-tests",
              timestamp,
              body,
            ),
          },
        });
        expect(response.status).toBe(200);
      };
      await report("expired");
      expect(
        Detail.parse(await rpc("payments.get", { id: closed.paymentId }, accountant)).state.status,
      ).toBe("expired");
      await report("completed");
      const review = Detail.parse(await rpc("payments.get", { id: closed.paymentId }, accountant));
      expect(review.state).toEqual({ status: "needsReview", reason: "paid after close" });
      expect(review.posting).toBeNull();
      expect(
        Ledger.parse(await rpc("accounts.ledger", { id: accountId }, accountant)).balances,
      ).toEqual([{ currency: "GBP", balance: expectedBalance }]);
      process.stdout.write(
        `LIVE_LIFECYCLE ${JSON.stringify({ scenario: "paid after expiry", payment: review }, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}\n`,
      );
      await rpc(
        "payments.closeReview",
        { id: closed.paymentId, reason: "Assigned for handling outside this demo" },
        manager,
        true,
      );
      expect(
        Detail.parse(await rpc("payments.get", { id: closed.paymentId }, accountant)).state.status,
      ).toBe("failed");
      const waitingCheckout = await checkout("staff-close");
      await rpc(
        "payments.closeCheckout",
        { id: waitingCheckout.paymentId, reason: "Customer ended checkout" },
        agent,
        true,
      );
      const staffClosed = Detail.parse(
        await rpc("payments.get", { id: waitingCheckout.paymentId }, accountant),
      );
      expect(staffClosed.state).toEqual({ status: "failed", reason: "Customer ended checkout" });
      expect(staffClosed.posting).toBeNull();
      expect(await (await fetch(waitingCheckout.checkout.url)).text()).toContain("Status: failed");
      process.stdout.write(
        `LIVE_LIFECYCLE ${JSON.stringify({ scenario: "staff closure", payment: staffClosed }, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}\n`,
      );
      expect(await db.rows("SELECT count(*)::int AS n FROM outbox")).toEqual([{ n: 2 }]);
      const Receipt = z.object({
        id: z.string(),
        state: z.string(),
        attempts: z.number(),
        nextAttemptAt: z.date().nullable(),
        history: z.array(
          z.object({
            state: z.string(),
            number: z.number(),
            reason: z.string().nullable(),
            startedAt: z.date(),
            finishedAt: z.date().nullable(),
          }),
        ),
      });
      const Manual = Detail.extend({
        version: z.number(),
        approvals: z.array(
          z.object({
            approverId: z.string(),
            roleVersion: z.number(),
            at: z.date(),
            voidedAt: z.date().nullable(),
          }),
        ),
        receipt: Receipt.nullable(),
        actions: z.object({
          approve: z.boolean(),
          roleVersion: z.number(),
          requeueReceipt: z.boolean(),
        }),
      });
      const log = (label: string, value: unknown) =>
        process.stdout.write(
          `LIVE_MANUAL ${label} ${JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item))}\n`,
        );
      const record = async (key: string, hash: string, amount = "100", recordedBy = agent) =>
        z.object({ id: z.string() }).parse(
          await rpc(
            "payments.recordManual",
            {
              key,
              accountId,
              amount,
              currency: "GBP",
              kind: "repeat",
              receiptHash: hash.repeat(64),
              reference: "Local transfer",
            },
            recordedBy,
            true,
          ),
        ).id;
      const approve = async (id: string, cookie: string) => {
        const view = Manual.parse(await rpc("payments.get", { id }, cookie));
        return rpc(
          "payments.approve",
          { id, version: view.version, roleVersion: view.actions.roleVersion },
          cookie,
          true,
        );
      };
      const work = async () => {
        const response = await fetch(server.url("/api/payments/outbox"), {
          method: "POST",
          headers: { authorization: `Bearer ${outboxSecret}` },
        });
        expect(response.status).toBe(200);
        const result: unknown = await response.json();
        return result;
      };
      expect((await fetch(server.url("/api/payments/outbox"), { method: "POST" })).status).toBe(
        401,
      );
      const manualId = await record("manual-first", "a", "48000", manager);
      const refused = await post(
        "/api/trpc/payments.recordManual",
        {
          json: {
            key: "manual-duplicate",
            accountId,
            amount: "100",
            currency: "GBP",
            kind: "repeat",
            receiptHash: "b".repeat(64),
          },
        },
        agent,
      );
      const refusal: unknown = await refused.json();
      expect(refused.status).toBe(409);
      expect(refusal).toMatchObject({
        error: { json: { data: { accessFailure: "pendingPayment" } } },
      });
      log("second-payment-refused", refusal);
      const agentApproval = await post(
        "/api/trpc/payments.approve",
        { json: { id: manualId, version: 0, roleVersion: 0 } },
        agent,
      );
      expect(agentApproval.status).toBe(403);
      const blockedCard = await post(
        "/api/trpc/payments.createCheckout",
        {
          json: {
            key: "card-while-manual",
            accountId,
            amount: "48000",
            currency: "GBP",
            kind: "repeat",
            mode: "drop",
          },
        },
        agent,
      );
      expect(blockedCard.status).toBe(409);
      const blockedCardBody: unknown = await blockedCard.json();
      expect(blockedCardBody).toMatchObject({
        error: {
          json: {
            message: "This account already has a payment in progress.",
            data: { accessFailure: "pendingPayment" },
          },
        },
      });
      log("card-refused-while-manual-waits", blockedCardBody);
      await rpc(
        "payments.editManual",
        {
          id: manualId,
          version: 0,
          amount: "4800000",
          currency: "GBP",
          receiptHash: "a".repeat(64),
          reference: "Corrected transfer",
        },
        editor,
        true,
      );
      const editorApproval = await post(
        "/api/trpc/payments.approve",
        { json: { id: manualId, version: 1, roleVersion: 0 } },
        editor,
      );
      expect(editorApproval.status).toBe(400);
      const editorRefusal: unknown = await editorApproval.json();
      expect(editorRefusal).toMatchObject({
        error: { json: { data: { accessFailure: "paymentMaker" } } },
      });
      log("editor-approval-refused", editorRefusal);
      await approve(manualId, accountant);
      const waiting = Manual.parse(await rpc("payments.get", { id: manualId }, accountant));
      expect(waiting.state.status).toBe("pendingApproval");
      expect(waiting.posting).toBeNull();
      await approve(manualId, owner);
      const completed = Manual.parse(await rpc("payments.get", { id: manualId }, accountant));
      expect(completed.state.status).toBe("completed");
      expect(completed.approvals).toHaveLength(2);
      expect(completed.posting?.lines.map((l) => l.amount)).toEqual([4800000n, 4800000n]);
      expect(completed.posting?.lines.map((l) => l.account.kind)).toContain("bankTransfersCash");
      const manualLedger = Ledger.parse(
        await rpc("accounts.ledger", { id: accountId }, accountant),
      );
      expect(manualLedger.balances).toEqual([
        { currency: "GBP", balance: expectedBalance + 4800000n },
      ]);
      log("completed", { payment: completed, ledger: manualLedger });
      const cli = await promisify(exec)("pnpm outbox", {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        timeout: 20_000,
        env: {
          ...process.env,
          DATABASE_URL: db.connectionString,
          NODE_ENV: "production",
          RELAY_DEV_ACTOR: "",
          RELAY_SANDBOX: "",
          AUTH_URL: origin,
          AUTH_SECRET: "fake-production-payment-auth-secret-for-tests",
          SMTP_URL: inbox.url,
          SMTP_FROM: "relay@sender.example",
        },
      });
      expect(cli.stdout).toContain('"state":"sent"');
      log("pnpm-outbox", cli.stdout);
      const received = inbox.messages.find((message) => message.includes(`Payment ${manualId}`));
      expect(received).toContain("Received GBP 48000.00.");
      log("smtp-receipt", received);
      expect(
        Manual.parse(await rpc("payments.get", { id: manualId }, accountant)).receipt,
      ).toMatchObject({ state: "sent", attempts: 1 });

      const failedId = await record("manual-failed", "b");
      await approve(failedId, accountant);
      await approve(failedId, manager);
      await inbox.close();
      try {
        await work();
      } finally {
        await inbox.reopen();
      }
      const failed = Manual.parse(await rpc("payments.get", { id: failedId }, accountant));
      expect(failed.receipt).toMatchObject({ state: "failed", attempts: 1 });
      const last = failed.receipt?.history[0];
      expect(failed.receipt?.nextAttemptAt?.getTime()).toBe(
        (last?.finishedAt?.getTime() ?? 0) + 300000,
      );
      const beforeRetry = inbox.messages.length;
      await work();
      expect(inbox.messages).toHaveLength(beforeRetry);
      expect(last?.reason).toBe("Could not connect to the mail server.");
      log("connection-refused-scheduled", failed.receipt);
      await db.rows("UPDATE outbox SET next_attempt_at=now() WHERE payment_id=$1", [failedId]);
      receiptOutcome = "sent";
      await work();
      const retried = Manual.parse(await rpc("payments.get", { id: failedId }, accountant));
      expect(retried.receipt).toMatchObject({ state: "sent", attempts: 2 });
      log("connection-refused-delivered-after-receiver-reopened", retried.receipt);

      const suppressedId = await record("manual-suppressed", "c");
      await approve(suppressedId, accountant);
      await approve(suppressedId, manager);
      await db.rows(
        "INSERT INTO email_suppressions(email,reason) VALUES ('customer@example.com','Local suppression test')",
      );
      const beforeSuppression = inbox.messages.length;
      await work();
      expect(inbox.messages).toHaveLength(beforeSuppression);
      const suppressed = Manual.parse(await rpc("payments.get", { id: suppressedId }, accountant));
      expect(suppressed.receipt).toMatchObject({ state: "suppressed", attempts: 0 });
      expect(suppressed.state.status).toBe("completed");
      log("suppressed", suppressed.receipt);
      await db.rows("DELETE FROM email_suppressions WHERE email='customer@example.com'");

      const unknownId = await record("manual-unknown", "d");
      await approve(unknownId, accountant);
      await approve(unknownId, manager);
      receiptOutcome = "unknown";
      await work();
      const unknown = Manual.parse(await rpc("payments.get", { id: unknownId }, accountant));
      expect(unknown.receipt).toMatchObject({ state: "unknown", attempts: 1, nextAttemptAt: null });
      const beforeUnknown = inbox.messages.length;
      await work();
      expect(inbox.messages).toHaveLength(beforeUnknown);
      log("unknown-no-auto-retry", unknown.receipt);
      await rpc("payments.requeueReceipt", { id: unknownId }, accountant, true);
      receiptOutcome = "sent";
      await work();
      expect(
        Manual.parse(await rpc("payments.get", { id: unknownId }, accountant)).receipt,
      ).toMatchObject({ state: "sent", attempts: 2 });
      const cappedId = await record("manual-cap", "e");
      await approve(cappedId, accountant);
      await approve(cappedId, manager);
      receiptOutcome = "failed";
      await work();
      await rpc("payments.requeueReceipt", { id: cappedId }, accountant, true);
      await work();
      const capped = await post(
        "/api/trpc/payments.requeueReceipt",
        { json: { id: cappedId } },
        accountant,
      );
      expect(capped.status).toBe(409);
      const cappedBody: unknown = await capped.json();
      expect(cappedBody).toMatchObject({
        error: { json: { data: { accessFailure: "receiptAttemptLimit" } } },
      });
      const capDetail = Manual.parse(await rpc("payments.get", { id: cappedId }, accountant));
      expect(capDetail.receipt).toMatchObject({
        state: "failed",
        attempts: 2,
        nextAttemptAt: null,
      });
      expect(capDetail.actions.requeueReceipt).toBe(false);
      log("lifetime-cap-refused", { refusal: cappedBody, receipt: capDetail.receipt });
    } finally {
      await server.stop();
      await inbox.close();
    }
  },
);

databaseTest(
  "plain next start refuses clients with no verified address and logs once",
  async ({ db }) => {
    const server = await serve({}, db.connectionString, true);
    try {
      for (let i = 0; i < 2; i += 1) {
        const response = await fetch(server.url("/api/intake/form"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "nobody@example.com" }),
        });
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ message: "Something went wrong." });
      }
      expect(server.output().split("server.clientAddressUnavailable")).toHaveLength(2);
      expect(await db.rows("SELECT * FROM auth_request_limits")).toEqual([]);
      expect((await db.counts()).leads).toBe(0);
    } finally {
      await server.stop();
    }
  },
);
