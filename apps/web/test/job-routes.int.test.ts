import { expect, vi } from "vitest";
import { test } from "@relay/store/testing";
import { connections } from "../src/server/client-address.ts";

const latch = (): PromiseWithResolvers<void> => Promise.withResolvers();

const state = vi.hoisted((): { app: unknown } => ({ app: null }));
vi.mock("@/server/composition.ts", () => ({ composition: () => state.app }));
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
