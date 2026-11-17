import { z } from "zod";
import { expect, vi } from "vitest";
import { test } from "@relay/store/testing";
import type { Composition } from "../src/server/composition.ts";
import { createAuthentication } from "../src/server/auth.ts";
import { connections } from "../src/server/client-address.ts";
import { parseEnv } from "../src/server/env.ts";
import { handleRpc } from "../src/server/rpc.ts";
import { rpcContext } from "../src/server/rpc-context.ts";

const app = vi.hoisted(() => {
  const state: { current: Pick<Composition, "env" | "store" | "auth" | "payments"> | null } = {
    current: null,
  };
  return state;
});
vi.mock("../src/server/composition.ts", () => ({ composition: () => app.current }));
const origin = "http://localhost:3406";

test.for([false, true])(
  "server.info returns only anonymous sign-in facts with every credential in demo=%s",
  async (demo, { db }) => {
    await db.seedUser("agent");
    const env = parseEnv({
      DATABASE_URL: db.connectionString,
      AUTH_URL: origin,
      AUTH_SECRET: "fake-server-info-test-secret-0123456789",
      SMTP_URL: "smtp://127.0.0.1:9",
      SMTP_FROM: "relay@sender.example",
      RELAY_TIME_ZONE: "Europe/Bucharest",
      ...(demo ? { RELAY_DEMO: "1" } : {}),
    });
    if (!env.auth) throw new Error("Missing test authentication");
    let code = "";
    const tasks: (() => Promise<void>)[] = [];
    const auth = createAuthentication(
      db.store,
      env.auth,
      (message) => {
        code = message.code;
        return Promise.resolve();
      },
      (task) => {
        tasks.push(task);
      },
      demo,
    );
    app.current = { store: db.store, env, auth, payments: null };
    const post = async (path: string, body: unknown, browser: boolean) => {
      const response = await connections.run("127.0.0.1", () =>
        auth.handle(
          new Request(`${origin}/api/auth/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(browser ? { origin } : {}) },
            body: JSON.stringify(body),
          }),
        ),
      );
      for (const task of tasks.splice(0)) await task();
      expect(response.status).toBe(200);
      return response;
    };
    const email = "user-1@team.example";
    await post("email-otp/send-verification-otp", { email, type: "sign-in" }, true);
    const browser = await post("sign-in/email-otp", { email, otp: code }, true);
    const cookie = browser.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    await post("native/send-code", { email }, false);
    const native = await post("native/sign-in", { email, otp: code }, false);
    const { token } = z.object({ token: z.string() }).parse(await native.json());
    const principal = vi.spyOn(auth, "principal");
    const before = await db.rows("SELECT * FROM auth_sessions ORDER BY id");
    for (const credentials of [
      {},
      { cookie },
      { cookie: "relay.session_token=invalid" },
      { authorization: `Bearer ${token}` },
      { authorization: "Bearer invalid" },
      { authorization: "Bearer invalid", origin, cookie },
      { authorization: `Bearer ${token}`, origin, cookie },
    ]) {
      const request = new Request(`${origin}/api/trpc/server.info`, { headers: credentials });
      const response = await handleRpc(
        request,
        ({ publicQuery }) => rpcContext(request.headers, publicQuery),
        origin,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        result: {
          data: {
            json: {
              demo,
              demoAgentName: demo ? "Dele Akinwale" : null,
            },
          },
        },
      });
    }
    expect(principal).not.toHaveBeenCalled();
    expect(await db.rows("SELECT * FROM auth_sessions ORDER BY id")).toEqual(before);
    principal.mockRestore();
    const failingStore = new Proxy(db.store, {
      get() {
        throw new Error("Public metadata must not read the store");
      },
    });
    app.current = { store: failingStore, env, auth, payments: null };
    const request = new Request(`${origin}/api/trpc/server.info`);
    expect(
      (
        await handleRpc(
          request,
          ({ publicQuery }) => rpcContext(request.headers, publicQuery),
          origin,
        )
      ).status,
    ).toBe(200);
  },
);

test("a public query cannot bypass authentication for a batched session query", async ({ db }) => {
  app.current = {
    store: db.store,
    env: parseEnv({ DATABASE_URL: db.connectionString }),
    auth: null,
    payments: null,
  };
  const request = new Request(`${origin}/api/trpc/server.info,session.profile?batch=1`, {
    headers: { authorization: "Bearer invalid", origin },
  });
  expect(
    (
      await handleRpc(
        request,
        ({ publicQuery }) => rpcContext(request.headers, publicQuery),
        origin,
      )
    ).status,
  ).toBe(403);
});
