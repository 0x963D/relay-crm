import { serve } from "./support/production-server.ts";
import { submissionExample } from "@relay/domain/testing";
import { seedDemo } from "@relay/store/demo";
import { REQUIRED_MIGRATION } from "../../../packages/store/src/demo-state.ts";
import { DEMO_PEOPLE } from "@relay/store";
import { limitKey } from "../src/server/rate-limit.ts";
import { randomUUID } from "node:crypto";
import { signPaymentBody } from "../src/server/payments/webhook.ts";
import superjson from "superjson";
import { z } from "zod";
import { setTimeout as sleep } from "node:timers/promises";
import { test as databaseTest } from "@relay/store/testing";
import { openSmtpInbox } from "./support/smtp.ts";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

databaseTest(
  "a production demo offers each role and keeps emailed sign-in",
  { timeout: 120_000 },
  async ({ db }) => {
    await seedDemo({
      ownerUrl: db.ownerConnectionString,
      appUrl: db.connectionString,
      today: new Date(),
      deliver: () => Promise.resolve({ state: "sent" }),
    });
    const inbox = await openSmtpInbox();
    for (const demo of [false, true]) {
      const server = await serve(
        (origin) => ({
          AUTH_URL: origin,
          AUTH_SECRET: "fake-demo-production-auth-secret-0123456789",
          SMTP_URL: inbox.url,
          SMTP_FROM: "relay@sender.example",
          ...(demo ? { RELAY_DEMO: "1" } : {}),
        }),
        db.connectionString,
      );
      try {
        const origin = new URL(server.url("/")).origin;
        const post = (path: string, body: unknown, sentOrigin = origin) =>
          fetch(server.url(path), {
            method: "POST",
            headers: { origin: sentOrigin, "content-type": "application/json" },
            body: JSON.stringify(body),
          });
        const signedOut = await fetch(server.url("/"));
        const firstPage = await signedOut.text();
        expect(signedOut.status).toBe(200);
        expect(firstPage).not.toContain("RELAY_DEV_ACTOR");
        if (demo) {
          for (const role of ["manager", "agent", "accountant"] as const)
            expect(firstPage).toContain(DEMO_PEOPLE[role].name);
        } else {
          expect(firstPage).toContain("/api/auth/email-otp/send-verification-otp");
          expect(firstPage).toContain("Send me a code");
        }
        if (!demo) {
          for (const role of ["manager", "agent", "accountant"])
            expect((await post("/api/auth/demo", { role })).status).toBe(404);
          expect((await post("/api/demo/reset", {})).status).toBe(404);
          expect(
            (
              await fetch(server.url("/api/auth/native/demo"), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ role: "agent" }),
              })
            ).status,
          ).toBe(404);
          continue;
        }
        const nativeDemo = await fetch(server.url("/api/auth/native/demo"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "agent" }),
        });
        expect(nativeDemo.status).toBe(200);
        expect(nativeDemo.headers.has("set-cookie")).toBe(false);
        const nativeDemoBody = z
          .object({
            token: z.string().min(32),
            expiresAt: z.iso.datetime(),
            user: z.object({ id: z.uuid(), role: z.literal("agent") }),
          })
          .parse(await nativeDemo.json());
        expect(nativeDemoBody).toMatchObject({
          user: { id: DEMO_PEOPLE.agent.id, role: "agent" },
        });
        expect((await post("/api/demo/reset", {})).status).toBe(404);
        expect((await fetch(server.url("/api/auth/demo"))).status).toBe(404);
        expect((await post("/api/auth/demo", { role: "owner" })).status).toBe(400);
        expect(
          (await post("/api/auth/demo", { role: "manager", userId: DEMO_PEOPLE.manager.id }))
            .status,
        ).toBe(400);
        expect(
          (await post("/api/auth/demo", { role: "manager" }, "https://outside.example")).status,
        ).toBe(403);
        for (const role of ["manager", "agent", "accountant"] as const) {
          const response = await post("/api/auth/demo", { role });
          expect(response.status, await response.clone().text()).toBe(200);
          const body: unknown = await response.json();
          expect(body).toMatchObject({
            user: { name: DEMO_PEOPLE[role].name, role },
            roles: ["manager", "agent", "accountant"],
          });
          const cookie = response.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; ");
          const session = await fetch(server.url("/api/auth/get-session"), {
            headers: { cookie, origin, authorization: "Basic dXNlcjpwYXNz" },
          });
          expect(session.status, server.output()).toBe(200);
          const current: unknown = await session.json();
          expect(current).toMatchObject({ user: { id: DEMO_PEOPLE[role].id } });
          expect(current).not.toHaveProperty("session.token");
          const landing = await fetch(server.url("/"), { headers: { cookie } });
          expect(new URL(landing.url).pathname).toBe(
            role === "manager" ? "/pool" : role === "agent" ? "/queue" : "/payments",
          );
          if (role === "accountant") expect(await landing.text()).toContain("Payments");
        }
        const email = DEMO_PEOPLE.manager.email;
        expect(
          (await post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" }))
            .status,
        ).toBe(200);
        for (let i = 0; i < 100 && inbox.messages.length === 0; i++) await sleep(50);
        const otp = inbox.messages[0]?.match(/Your sign-in code is (\d{6})/)?.[1];
        expect(otp).toMatch(/^\d{6}$/);
        expect((await post("/api/auth/sign-in/email-otp", { email, otp })).status).toBe(200);
        await db.rows("UPDATE auth_request_limits SET count=20 WHERE key=$1", [
          limitKey("demo:client", "127.0.0.1"),
        ]);
        const limited = await post("/api/auth/demo", { role: "manager" });
        expect(limited.status).toBe(429);
        expect(limited.headers.get("retry-after")).toBe("60");
      } finally {
        await server.stop();
      }
    }
    await inbox.close();
  },
);

databaseTest(
  "the production server mounts native sessions with a different AUTH_URL and no token logs",
  async ({ db }) => {
    const userId = await db.seedUser("agent");
    const teamId = await db.seedTeam("sales");
    await db.ownerRows("INSERT INTO memberships(user_id,team_id) VALUES ($1,$2)", [userId, teamId]);
    const id = await db.seedLead({
      email: "native-production@example.com",
      lifecycle: {
        state: { status: "assigned", assignee: { ownerId: userId, teamId } },
        firstAssignedAt: new Date(),
        previousOwnerId: null,
      },
    });
    const inbox = await openSmtpInbox();
    const server = await serve(
      {
        AUTH_URL: "http://localhost:1",
        AUTH_SECRET: "fake-native-production-secret-0123456789",
        SMTP_URL: inbox.url,
        SMTP_FROM: "relay@sender.example",
      },
      db.connectionString,
    );
    try {
      const post = async (path: string, body: unknown, headers: HeadersInit = {}) => {
        const response = await fetch(server.url(path), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...Object.fromEntries(new Headers(headers)),
          },
          body: JSON.stringify(body),
        });
        expect(response.headers.has("set-cookie")).toBe(false);
        expect(
          [...response.headers.keys()].some((header) => header.startsWith("access-control-")),
        ).toBe(false);
        return response;
      };
      const email = "user-1@team.example";
      expect(
        (await post("/api/auth/native/send-code", { email }, { cookie: "__cf_bm=abc" })).status,
      ).toBe(200);
      for (let i = 0; i < 100 && inbox.messages.length === 0; i++) await sleep(50);
      const otp = inbox.messages[0]?.match(/Your sign-in code is (\d{6})/)?.[1];
      expect(otp).toMatch(/^\d{6}$/);
      const response = await post(
        "/api/auth/native/sign-in",
        { email, otp },
        { cookie: "__cf_bm=abc" },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const signed = z
        .object({
          token: z.string(),
          expiresAt: z.iso.datetime(),
          user: z.object({ id: z.uuid(), name: z.string(), role: z.literal("agent") }).strict(),
        })
        .strict()
        .parse(await response.json());
      expect(signed.user.id).toBe(userId);
      const headers = { authorization: `Bearer ${signed.token}`, cookie: "__cf_bm=abc" };
      const session = await fetch(server.url("/api/auth/get-session"), { headers });
      expect(session.headers.has("set-cookie")).toBe(false);
      expect(await session.json()).toMatchObject({ user: signed.user });
      const rpcUrl = (path: string) =>
        server.url(`/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: {} }))}`);
      expect((await fetch(rpcUrl("session.current"), { headers })).status).toBe(200);
      const queue = await fetch(rpcUrl("leads.queue"), { headers });
      expect(queue.status).toBe(200);
      expect(await queue.text()).toContain(id);
      const note = { json: { id, key: "native-production-note", note: "Called from a phone." } };
      expect((await post("/api/trpc/leads.addNote", note, headers)).status).toBe(200);
      expect(
        (
          await post("/api/trpc/leads.addNote", note, {
            ...headers,
            origin: new URL(server.url("/")).origin,
          })
        ).status,
      ).toBe(403);
      expect(
        (await fetch(rpcUrl("session.current"), { headers: { ...headers, cookie: "__cf_bm=abc" } }))
          .status,
      ).toBe(200);
      const unknown = "x".repeat(32);
      expect(
        (
          await fetch(rpcUrl("session.current"), {
            headers: { authorization: `Bearer ${unknown}` },
          })
        ).status,
      ).toBe(401);
      expect((await post("/api/auth/native/sign-out", {}, headers)).status).toBe(200);
      expect((await fetch(rpcUrl("session.current"), { headers })).status).toBe(401);
      expect(server.output()).not.toContain(signed.token);
      expect(server.output()).not.toContain(unknown);
    } finally {
      await server.stop();
      await inbox.close();
    }
  },
);

databaseTest(
  "health returns no details and refuses a reachable database missing its migration",
  async ({ db }) => {
    const server = await serve({ RELAY_PUBLIC_FORM: "0" }, db.connectionString);
    try {
      expect((await fetch(server.url("/api/intake/form"), { method: "POST" })).status).toBe(404);
      const healthy = await fetch(server.url("/api/health"));
      expect(healthy.status).toBe(200);
      expect(await healthy.text()).toBe("");
      await db.ownerRows(
        "INSERT INTO demo_seed(key,company,state,seeded_at) VALUES ('tidewell-language-school/v1','Tidewell Language School','ready',now())",
      );
      const demo = await serve(
        (origin) => ({
          RELAY_DEMO: "1",
          AUTH_URL: origin,
          AUTH_SECRET: "fake-readiness-production-secret-0123456789",
          SMTP_URL: "smtp://127.0.0.1:9",
          SMTP_FROM: "relay@sender.example",
        }),
        db.connectionString,
      );
      try {
        expect((await fetch(demo.url("/sign-in"))).status).toBe(200);
        await db.ownerRows("DELETE FROM _prisma_migrations WHERE migration_name=$1", [
          REQUIRED_MIGRATION,
        ]);
        const unhealthy = await fetch(server.url("/api/health"));
        expect(unhealthy.status).toBe(503);
        expect(await unhealthy.text()).toBe("");
        for (const path of ["/api/health", "/sign-in", "/api/trpc/server.info"]) {
          const response = await fetch(demo.url(path));
          expect(response.status).toBe(503);
          expect(response.headers.get("retry-after")).toBe("1");
        }
      } finally {
        await demo.stop();
      }
    } finally {
      await server.stop();
    }
  },
);

databaseTest(
  "the production work journey signs in, wins a form lead and reads its account and funnel",
  async ({ db }) => {
    await db.ownerRows(
      "INSERT INTO demo_seed(key,company,state,seeded_at) VALUES ('tidewell-language-school/v1','Tidewell Language School','ready',now())",
    );
    const managerId = await db.seedUser("manager");
    const agentId = await db.seedUser("agent");
    const teamId = await db.seedTeam("sales");
    await db.ownerRows("INSERT INTO memberships(user_id,team_id) VALUES ($1,$3),($2,$3)", [
      managerId,
      agentId,
      teamId,
    ]);
    const inbox = await openSmtpInbox();
    const server = await serve(
      (origin) => ({
        AUTH_URL: origin,
        AUTH_SECRET: "fake-work-journey-secret-at-least-thirty-two-characters",
        SMTP_URL: inbox.url,
        SMTP_FROM: "relay@sender.example",
        RELAY_TIME_ZONE: "Pacific/Auckland",
        RELAY_DEMO: "1",
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
          .find((value) => value.includes("relay.session_token="))
          ?.split(";")[0];
        if (!cookie) throw new Error("No session cookie");
        return cookie;
      };
      const manager = await signIn("user-1@team.example");
      const agent = await signIn("user-2@team.example");
      const requestIds: string[] = [];
      const rpc = async (
        path: string,
        input: unknown,
        cookie: string,
        mutation = false,
      ): Promise<unknown> => {
        const encoded = superjson.serialize(input);
        const response = mutation
          ? await post(`/api/trpc/${path}`, encoded, cookie)
          : await fetch(
              server.url(`/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify(encoded))}`),
              { headers: { cookie } },
            );
        const raw: unknown = await response.json();
        expect(response.status, JSON.stringify(raw)).toBe(200);
        const requestId = response.headers.get("x-request-id");
        if (mutation && requestId) requestIds.push(requestId);
        const envelope = z.object({ result: z.object({ data: z.unknown() }) }).parse(raw);
        return superjson.parse(JSON.stringify(envelope.result.data));
      };
      const form = await post("/api/intake/form", {
        submissionId: randomUUID(),
        email: "journey@example.com",
        name: "Riley Morgan",
        phone: "+447700900123",
        campaign: "Evening course",
        form: "Course enquiry",
      });
      expect(form.status).toBe(202);
      const pool = z
        .array(z.object({ id: z.string(), email: z.string() }))
        .parse(await rpc("leads.list", { limit: 100 }, manager));
      const id = pool.find((lead) => lead.email === "journey@example.com")?.id;
      if (!id) throw new Error("Form lead missing from the pool");
      await rpc("leads.assign", { leadIds: [id], to: { ownerId: agentId, teamId } }, manager, true);
      const Queue = z.object({
        notYetCalled: z.array(z.object({ id: z.string(), campaign: z.string().nullable() })),
        timeZone: z.string(),
      });
      const queue = Queue.parse(await rpc("leads.queue", {}, agent));
      expect(queue.notYetCalled).toEqual([{ id, campaign: "Evening course" }]);
      expect(queue.timeZone).toBe("Pacific/Auckland");
      await rpc(
        "leads.logAttempt",
        { id, key: "journey-no-answer", channel: "call", outcome: "noAnswer", note: "Rang out" },
        agent,
        true,
      );
      const Detail = z.object({
        id: z.string(),
        contactedAt: z.date().nullable(),
        noAnswerCount: z.number(),
        lifecycle: z.object({
          state: z.object({ status: z.string(), accountId: z.string().optional() }),
        }),
        custody: z.object({
          assignedBy: z.object({ id: z.string() }).nullable(),
          heldBy: z.object({ id: z.string() }).nullable(),
        }),
        timeline: z.array(
          z.object({ kind: z.string(), sequence: z.bigint(), detail: z.unknown() }),
        ),
      });
      const workedQueue = z
        .object({ noCallbackSet: z.array(z.object({ id: z.string() })) })
        .parse(await rpc("leads.queue", {}, agent));
      expect(workedQueue.noCallbackSet.map((lead) => lead.id)).toEqual([id]);
      const unanswered = Detail.parse(await rpc("leads.get", { id }, agent));
      expect(unanswered.contactedAt).toBeNull();
      expect(unanswered.noAnswerCount).toBe(1);
      const callbackAt = new Date(Date.now() + 3600000);
      await rpc(
        "leads.setCallback",
        { id, key: "journey-callback", change: { kind: "set", at: callbackAt } },
        agent,
        true,
      );
      const Callback = z.object({
        lifecycle: z.object({ state: z.object({ stage: z.object({ at: z.date() }) }) }),
      });
      expect(
        Callback.parse(await rpc("leads.get", { id }, agent)).lifecycle.state.stage.at,
      ).toEqual(callbackAt);
      await rpc(
        "leads.logAttempt",
        {
          id,
          key: "journey-spoke",
          channel: "call",
          outcome: "spokeToThem",
          note: "Agreed to join the evening course",
          callback: { kind: "set", at: callbackAt },
        },
        agent,
        true,
      );
      await rpc("leads.close", { id, key: "journey-win", closing: { kind: "won" } }, agent, true);
      const detail = Detail.parse(await rpc("leads.get", { id }, agent));
      expect(detail.lifecycle.state.status).toBe("won");
      expect(detail.contactedAt).toBeInstanceOf(Date);
      expect(detail.custody.assignedBy?.id).toBe(managerId);
      expect(detail.custody.heldBy?.id).toBe(agentId);
      expect(detail.timeline.map((item) => item.kind)).toEqual([
        "closure",
        "attempt",
        "callback",
        "attempt",
        "assignment",
        "intake",
      ]);
      expect(detail.timeline.map((item) => item.sequence)).toEqual(
        detail.timeline.map((item) => item.sequence).sort((a, b) => (a > b ? -1 : 1)),
      );
      const Accounts = z.object({
        items: z.array(
          z.object({
            id: z.string(),
            owner: z.object({ id: z.string() }).nullable(),
            balances: z.array(z.unknown()).nullable(),
          }),
        ),
      });
      const accounts = Accounts.parse(await rpc("accounts.list", { limit: 100 }, manager)).items;
      expect(accounts).toEqual([
        { id: detail.lifecycle.state.accountId, owner: { id: agentId }, balances: [] },
      ]);
      expect(
        Accounts.parse(await rpc("accounts.list", { limit: 100 }, agent)).items[0]?.balances,
      ).toBeNull();
      const funnel = z
        .object({
          rows: z.array(
            z.object({
              campaign: z.string().nullable(),
              received: z.number(),
              unassigned: z.number(),
              contacted: z.number().nullable(),
              won: z.number(),
              conversion: z.number().nullable(),
            }),
          ),
        })
        .parse(await rpc("reports.funnel", undefined, manager)).rows;
      expect(funnel).toEqual([
        {
          campaign: "Evening course",
          received: 1,
          unassigned: 0,
          contacted: 1,
          won: 1,
          conversion: 1,
        },
      ]);
      expect(
        await db.ownerRows("SELECT request_id FROM audit_log WHERE subject_id=$1 ORDER BY at,id", [
          id,
        ]),
      ).toHaveLength(requestIds.length);
      expect(
        (await db.ownerRows("SELECT request_id FROM audit_log WHERE subject_id=$1", [id]))
          .map((row) => row.request_id)
          .sort(),
      ).toEqual(requestIds.sort());
      process.stdout.write(
        `LIVE_WORK ${JSON.stringify({ queue, unanswered, callbackAt, detail, accounts, funnel, correlatedWrites: requestIds.length }, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}\n`,
      );
      const dated = z
        .object({
          timeline: z.array(
            z.object({
              kind: z.string(),
              summary: z
                .object({ callbackAt: z.date().nullable(), noAnswerCount: z.number().nullable() })
                .nullable(),
            }),
          ),
        })
        .parse(await rpc("leads.get", { id }, agent));
      expect(dated.timeline.find((entry) => entry.kind === "attempt")?.summary).toEqual({
        callbackAt,
        noAnswerCount: 1,
      });
      const secondAgentId = await db.seedUser("agent");
      await db.ownerRows("INSERT INTO memberships(user_id,team_id) VALUES ($1,$2)", [
        secondAgentId,
        teamId,
      ]);
      const secondAgent = await signIn("user-3@team.example");
      const email = "returning-journey@example.com";
      const enquiry = () =>
        post("/api/intake/form", {
          submissionId: randomUUID(),
          email,
          name: "Ada Journey",
          campaign: "Evening course",
        });
      expect((await enquiry()).status).toBe(202);
      const returningId = z
        .array(z.object({ id: z.string(), email: z.string() }))
        .parse(await rpc("leads.list", { limit: 100 }, manager))
        .find((lead) => lead.email === email)?.id;
      if (!returningId) throw new Error("No returning lead");
      const to = { ownerId: agentId, teamId };
      await rpc("leads.assign", { leadIds: [returningId], to }, manager, true);
      await rpc(
        "leads.logAttempt",
        {
          id: returningId,
          key: "returning-attempt",
          channel: "call",
          outcome: "noAnswer",
          note: "Rang out",
        },
        agent,
        true,
      );
      await rpc(
        "leads.close",
        {
          id: returningId,
          key: "returning-lost",
          closing: { kind: "lost", note: "Chose a closer school" },
        },
        agent,
        true,
      );
      const lostDetail = z
        .object({
          lostNote: z.string().nullable(),
          lifecycle: z.object({ state: z.object({ status: z.string() }) }),
          timeline: z.array(z.object({ kind: z.string(), detail: z.unknown() })),
        })
        .parse(await rpc("leads.get", { id: returningId }, agent));
      expect(lostDetail).toMatchObject({
        lostNote: "Chose a closer school",
        lifecycle: { state: { status: "lost" } },
      });
      expect(lostDetail.timeline[0]).toMatchObject({
        kind: "closure",
        detail: { closing: { kind: "lost", note: "Chose a closer school" } },
      });
      expect((await enquiry()).status).toBe(202);
      await rpc("leads.assign", { leadIds: [returningId], to }, manager, true);
      const reopenedQueue = Queue.parse(await rpc("leads.queue", {}, agent));
      expect(reopenedQueue.notYetCalled.map((lead) => lead.id)).toEqual([returningId]);
      await rpc(
        "leads.logAttempt",
        {
          id: returningId,
          key: "after-reopen",
          channel: "call",
          outcome: "noAnswer",
          note: "Rang out again",
        },
        agent,
        true,
      );
      await rpc(
        "leads.reassign",
        { leadId: returningId, to: { ownerId: secondAgentId, teamId } },
        manager,
        true,
      );
      const reassignedQueue = Queue.parse(await rpc("leads.queue", {}, secondAgent));
      expect(reassignedQueue.notYetCalled.map((lead) => lead.id)).toEqual([returningId]);
      await db.store.intake(
        submissionExample({
          source: "metaLeadAds",
          email: "ad-journey@example.com",
          externalId: "ad-journey",
          campaign: "Evening course",
        }),
      );
      const sourceFunnel = z
        .object({
          campaignCount: z.number(),
          otherSourceCount: z.number(),
          rows: z.array(
            z.object({
              source: z.string().nullable(),
              campaign: z.string().nullable(),
              received: z.number(),
            }),
          ),
        })
        .parse(await rpc("reports.funnel", undefined, manager));
      expect(sourceFunnel.campaignCount).toBe(1);
      expect(sourceFunnel.otherSourceCount).toBe(1);
      expect(sourceFunnel.rows).toEqual([
        { source: "webForm", campaign: "Evening course", received: 2 },
        { source: "metaLeadAds", campaign: "Evening course", received: 1 },
      ]);
      const managerAccounts = await rpc("accounts.list", { limit: 100 }, manager);
      const agentAccounts = await rpc("accounts.list", { limit: 100 }, agent);
      expect(managerAccounts).toMatchObject({
        total: 1,
        items: [
          expect.objectContaining({
            campaign: "Evening course",
            paymentCount: 0,
            paymentInProgress: null,
            balances: [],
          }),
        ],
      });
      expect(agentAccounts).toMatchObject({
        total: 1,
        items: [expect.objectContaining({ balances: null })],
      });
      process.stdout.write(
        `LIVE_QUEUE_FIXES ${JSON.stringify({ workedQueue, dated, lostDetail, reopenedQueue, reassignedQueue, sourceFunnel, managerAccounts, agentAccounts }, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}\n`,
      );
    } finally {
      await server.stop();
      await inbox.close();
    }
  },
);

describe("the production server with no session", () => {
  test("serves public sign-in and refuses RPC with 401 without a session", async () => {
    const server = await serve({});
    try {
      const response = await fetch(server.url("/"));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Send me a code");
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
      expect((await fetch(server.url("/"))).status).toBe(200);
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
      expect(server.output()).toContain('"class":"PrismaClientKnownRequestError"');
      expect(server.output()).not.toContain("database password leaked in this message");
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
    await db.ownerRows(
      "INSERT INTO demo_seed(key,company,state,seeded_at) VALUES ('tidewell-language-school/v1','Tidewell Language School','ready',now())",
    );
    const userId = await db.seedUser("agent");
    await db.seedUser("accountant");
    await db.seedUser("manager");
    await db.seedUser("manager");
    await db.seedUser("owner");
    const teamId = await db.seedTeam("sales");
    const accountId = await db.seedAccount();
    await db.ownerRows("UPDATE accounts SET owner_id=$1 WHERE id=$2", [userId, accountId]);
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
        for (const method of ["HEAD", "OPTIONS", "PUT"]) {
          const response = await fetch(created.checkout.url, { method });
          expect(response.headers.get("referrer-policy"), method).toBe("no-referrer");
        }
        const html = await page.text();
        expect(page.status).toBe(200);
        expect(html).toContain("Sandbox Provider checkout");
        expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Pay [^<]+<\/button>/);
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
      const dropped = await checkout("paid-while-provider-disabled");
      expect(
        (
          await fetch(dropped.checkout.url, {
            method: "POST",
            headers: { origin },
            redirect: "manual",
          })
        ).status,
      ).toBe(303);
      const disabled = await serve(
        (disabledOrigin) => ({
          AUTH_URL: disabledOrigin,
          AUTH_SECRET: "fake-production-payment-auth-secret-for-tests",
          SMTP_URL: inbox.url,
          SMTP_FROM: "relay@sender.example",
          RELAY_DEMO: "1",
        }),
        db.connectionString,
      );
      try {
        const response = await fetch(disabled.url("/api/trpc/payments.closeCheckout"), {
          method: "POST",
          headers: {
            origin: new URL(disabled.url("/")).origin,
            "content-type": "application/json",
            cookie: agent,
          },
          body: JSON.stringify({ json: { id: dropped.paymentId, reason: "Customer says unpaid" } }),
        });
        expect(response.status, await response.text()).toBe(200);
      } finally {
        await disabled.stop();
      }
      const beforeRecovery = Detail.parse(
        await rpc("payments.get", { id: dropped.paymentId }, accountant),
      );
      expect(beforeRecovery.state.status).toBe("failed");
      expect(beforeRecovery.events.at(-1)?.detail).toMatchObject({ providerAsked: false });
      expect(
        (
          await fetch(server.url("/api/payments/reconcile"), {
            method: "POST",
            headers: { authorization: `Bearer ${reconcileSecret}` },
          })
        ).status,
      ).toBe(200);
      const recovered = Detail.parse(
        await rpc("payments.get", { id: dropped.paymentId }, accountant),
      );
      expect(recovered.state).toEqual({ status: "needsReview", reason: "paid after close" });
      expect(recovered.posting).toBeNull();
      process.stdout.write(
        `LIVE_RECOVERY ${JSON.stringify({ before: beforeRecovery.state, after: recovered.state, posting: recovered.posting })}\n`,
      );
      const alreadyPaid = await checkout("paid-before-staff-close");
      expect(
        (
          await fetch(alreadyPaid.checkout.url, {
            method: "POST",
            headers: { origin },
            redirect: "manual",
          })
        ).status,
      ).toBe(303);
      const sameRequest = z
        .object({
          state: z.object({
            status: z.literal("needsReview"),
            reason: z.literal("paid after close"),
          }),
          message: z.string(),
        })
        .parse(
          await rpc(
            "payments.closeCheckout",
            { id: alreadyPaid.paymentId, reason: "Customer says unpaid" },
            agent,
            true,
          ),
        );
      expect(sameRequest.message).toBe(
        "The checkout was already paid. The payment needs review; nothing was credited.",
      );
      expect(
        Detail.parse(await rpc("payments.get", { id: alreadyPaid.paymentId }, accountant)).posting,
      ).toBeNull();
      expect(
        Ledger.parse(await rpc("accounts.ledger", { id: accountId }, accountant)).balances,
      ).toEqual([{ currency: "GBP", balance: expectedBalance }]);
      process.stdout.write(`LIVE_CLOSE ${JSON.stringify(sameRequest)}\n`);
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
      expect(await (await fetch(waitingCheckout.checkout.url)).text()).toMatch(
        /role="status"[^>]*>[^<]*failed/,
      );
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
      await rpc(
        "payments.editManual",
        {
          id: manualId,
          version: 1,
          amount: "4800000",
          currency: "GBP",
          receiptHash: "a".repeat(64),
          reference: "Reference corrected by recorder",
        },
        manager,
        true,
      );
      const editorApproval = await post(
        "/api/trpc/payments.approve",
        { json: { id: manualId, version: 2, roleVersion: 0 } },
        editor,
      );
      expect(editorApproval.status).toBe(400);
      const editorRefusal: unknown = await editorApproval.json();
      expect(editorRefusal).toMatchObject({
        error: {
          json: {
            message: "You edited this payment and cannot approve it.",
            data: { accessFailure: "paymentMaker" },
          },
        },
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
      await db.ownerRows(
        "INSERT INTO email_suppressions(email,reason) VALUES ('customer@example.com','Local suppression test')",
      );
      const beforeSuppression = inbox.messages.length;
      await work();
      expect(inbox.messages).toHaveLength(beforeSuppression);
      const suppressed = Manual.parse(await rpc("payments.get", { id: suppressedId }, accountant));
      expect(suppressed.receipt).toMatchObject({ state: "suppressed", attempts: 0 });
      expect(suppressed.state.status).toBe("completed");
      log("suppressed", suppressed.receipt);
      await db.ownerRows("DELETE FROM email_suppressions WHERE email='customer@example.com'");

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
