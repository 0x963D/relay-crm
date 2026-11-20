import { expect, vi } from "vitest";
import { test } from "@relay/store/testing";
import { connections } from "../src/server/client-address.ts";
import { MAX_BODY_BYTES } from "../src/server/http.ts";

const latch = (): PromiseWithResolvers<void> => Promise.withResolvers();

const state = vi.hoisted((): { app: unknown } => ({ app: null }));
vi.mock("@/server/composition.ts", () => ({ composition: () => state.app }));
import { POST as scheduled } from "../src/app/api/demo/jobs/route.ts";
import { POST as outbox } from "../src/app/api/payments/outbox/route.ts";
import { POST as reconcile } from "../src/app/api/payments/reconcile/route.ts";

for (const [name, post] of [
  ["outbox", outbox],
  ["reconcile", reconcile],
] as const) {
  test(`${name} limits failed secrets by client address`, async ({ db }) => {
    state.app = {
      store: db.store,
      receiptMailer: () => Promise.resolve({ state: "sent" }),
      payments: { provider: {} },
      env: {
        trustedProxyCount: 0,
        outboxSecret: "fake-job-secret",
        payments: { reconcileSecret: "fake-job-secret", intervalMs: 1000 },
      },
    };
    const request = () =>
      new Request(`http://localhost/api/payments/${name}`, {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      });
    for (let index = 0; index < 5; index += 1)
      expect((await connections.run("127.0.0.1", () => post(request()))).status).toBe(401);
    expect((await connections.run("127.0.0.1", () => post(request()))).status).toBe(429);
    expect((await connections.run("127.0.0.2", () => post(request()))).status).toBe(401);
  });
  test(`${name} refuses overlapping runs and releases its lock after failure`, async ({ db }) => {
    const entered = latch();
    const release = latch();
    let calls = 0;
    const run = async () => {
      calls += 1;
      if (calls === 1) {
        entered.resolve();
        await release.promise;
        throw new Error("fake job failure");
      }
      return [];
    };
    state.app = {
      store: { ...db.store, runOutbox: run, duePayments: run },
      receiptMailer: () => Promise.resolve({ state: "sent" }),
      payments: { provider: {} },
      env: {
        trustedProxyCount: 0,
        outboxSecret: "fake-job-secret",
        payments: { reconcileSecret: "fake-job-secret", intervalMs: 1000 },
      },
    };
    const request = () =>
      connections.run("127.0.0.1", () =>
        post(
          new Request(`http://localhost/api/payments/${name}`, {
            method: "POST",
            headers: { authorization: "Bearer fake-job-secret" },
          }),
        ),
      );
    const first = request();
    await entered.promise;
    try {
      expect((await request()).status).toBe(429);
      expect(calls).toBe(1);
    } finally {
      release.resolve();
      await first;
    }
    expect((await request()).status).toBe(200);
  });
}

test("the hosted schedule requires its own bearer, with both jobs attempted in order", async ({
  db,
}) => {
  const calls: string[] = [];
  const env: {
    scheduledSecret: string | null;
    trustedProxyCount: number;
    payments: { intervalMs: number; reconcileSecret: string };
  } = {
    scheduledSecret: null,
    trustedProxyCount: 1,
    payments: { intervalMs: 1000, reconcileSecret: "reconcile-test-only" },
  };
  let fail = true;
  state.app = {
    env,
    store: {
      ...db.store,
      duePayments: () => {
        calls.push("reconcile");
        if (fail) throw new Error("test reconcile failure");
        return [];
      },
      runOutbox: () => {
        calls.push("outbox");
        return [];
      },
    },
    payments: { provider: {} },
    receiptMailer: () => Promise.resolve({ state: "suppressed" }),
  };
  const request = (secret: string, forwarded?: string, body: string | null = null) =>
    new Request("https://relay.example/api/demo/jobs", {
      method: "POST",
      body,
      headers: {
        authorization: `Bearer ${secret}`,
        ...(forwarded ? { "x-forwarded-for": forwarded } : {}),
      },
    });

  expect((await scheduled(request("schedule-test-only"))).status).toBe(404);
  env.scheduledSecret = "schedule-test-only";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const denied = await scheduled(
      request("reconcile-test-only", `192.0.2.${String(attempt + 1)}, 203.0.113.1`),
    );
    expect(denied.status).toBe(attempt < 5 ? 401 : 429);
  }
  const oversized = await scheduled(
    request(env.scheduledSecret, undefined, "x".repeat(MAX_BODY_BYTES + 1)),
  );
  expect(oversized.status).toBe(413);
  expect(calls).toEqual([]);
  const partial = await scheduled(request(env.scheduledSecret));
  expect(partial.status).toBe(503);
  expect(await partial.json()).toEqual({ reconcile: 500, outbox: 200 });
  fail = false;
  const complete = await scheduled(request(env.scheduledSecret));
  expect(complete.status).toBe(200);
  expect(await complete.json()).toEqual({ reconcile: 200, outbox: 200 });
  expect(calls).toEqual(["reconcile", "outbox", "reconcile", "outbox"]);

  for (const held of ["reconcile", "outbox"] as const) {
    calls.length = 0;
    const lease = await db.store.exclusiveJob(held, async () => {
      const response = await scheduled(request("schedule-test-only"));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        reconcile: held === "reconcile" ? 429 : 200,
        outbox: held === "outbox" ? 429 : 200,
      });
      expect(calls).toEqual([held === "reconcile" ? "outbox" : "reconcile"]);
    });
    expect(lease.ran).toBe(true);
  }
});
