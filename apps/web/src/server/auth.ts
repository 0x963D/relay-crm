import { randomInt, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { parseEmail } from "@relay/domain";
import type { Store } from "@relay/store";
import { DEMO_ROLES, isAccessError } from "@relay/store";
import { createAuthEndpoint, APIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { z } from "zod";
import { boundedRequest, copyRequest } from "./http.ts";
import { failureResponse, protectHttp } from "./errors.ts";
import { clientAddress } from "./client-address.ts";
import { allowRequest, limitKey, rateLimited } from "./rate-limit.ts";
import type { AuthEnv } from "./env.ts";
import type { Mailer } from "./mailer.ts";
import { authMessages } from "../lib/failures.ts";
import { sessionCredentials } from "./session-credentials.ts";

const Email = z
  .string()
  .max(254)
  .transform((value, ctx) => {
    const parsed = parseEmail(value);
    if (parsed.ok) return parsed.value;
    ctx.addIssue({ code: "custom", message: "Enter a valid email address." });
    return z.NEVER;
  });
const SendCode = z.object({ email: Email, type: z.literal("sign-in") }).strict();
const NativeSendCode = z.object({ email: Email }).strict();
const SignIn = z.object({ email: Email, otp: z.string().regex(/^\d{6}$/) }).strict();
const DemoSignIn = z.object({ role: z.enum(DEMO_ROLES) }).strict();
const SignOut = z.object({}).strict();
const nativeRoutes = new Map([
  ["/native/send-code", "/email-otp/send-verification-otp"],
  ["/native/sign-in", "/sign-in/email-otp"],
  ["/native/demo", "/demo"],
  ["/native/sign-out", "/sign-out"],
]);

type Schedule = (task: () => Promise<void>) => void;

export function createAuthentication(
  store: Store,
  env: AuthEnv,
  mailer: Mailer,
  schedule: Schedule,
  demo = false,
) {
  const nativeRequest = new AsyncLocalStorage<boolean>();
  const demoEndpoint = (path: "/demo" | "/native/demo") =>
    createAuthEndpoint(path, { method: "POST", body: DemoSignIn }, async (ctx) => {
      if (!demo) throw new APIError("NOT_FOUND");
      const user = await store.demoPerson(ctx.body.role).catch((error: unknown) => {
        if (isAccessError(error))
          throw new APIError("FORBIDDEN", { message: authMessages.demoUnavailable });
        throw error;
      });
      const session = await ctx.context.internalAdapter.createSession(user.id);
      const person = { id: user.id, name: user.name, role: user.role };
      if (path === "/native/demo")
        return ctx.json({ token: session.token, expiresAt: session.expiresAt, user: person });
      await setSessionCookie(ctx, { session, user });
      return ctx.json({
        session: { id: session.id, expiresAt: session.expiresAt },
        user: person,
        roles: DEMO_ROLES,
      });
    });
  const auth = betterAuth({
    appName: "Relay",
    baseURL: env.baseUrl,
    secret: env.secret,
    logger: { disabled: true },
    onAPIError: { throw: true },
    database: store.authenticationDatabase,
    databaseHooks: {
      session: {
        create: {
          before: async (session) => ({
            data: {
              ...session,
              currentTeamId: await store.initialSessionTeam(session.userId),
              isNative: nativeRequest.getStore() ?? false,
            },
          }),
        },
      },
    },
    user: { modelName: "user" },
    session: {
      modelName: "authSession",
      expiresIn: 60 * 60 * 24,
      cookieCache: { enabled: false },
      additionalFields: {
        currentTeamId: { type: "string", required: false, input: false },
        isNative: { type: "boolean", defaultValue: false, input: false },
      },
    },
    account: { modelName: "authAccount" },
    verification: { modelName: "authVerification" },
    advanced: { database: { generateId: () => randomUUID() }, cookiePrefix: "relay" },
    rateLimit: { enabled: false },
    plugins: [
      {
        id: "demo-sign-in",
        endpoints: {
          demoSignIn: demoEndpoint("/demo"),
          nativeDemoSignIn: demoEndpoint("/native/demo"),
        },
      },
      emailOTP({
        disableSignUp: true,
        expiresIn: 300,
        allowedAttempts: 3,
        storeOTP: "hashed",
        sendVerificationOTP: ({ email, otp }) => {
          schedule(() => mailer({ email, code: otp }));
          return Promise.resolve();
        },
      }),
    ],
  });

  async function dispatch(request: Request, native = false): Promise<Response> {
    const headers = new Headers(request.headers);
    if (
      native ||
      (headers.has("cookie") &&
        (await auth.api.getSession({ headers, query: { disableRefresh: true } }))?.session.isNative)
    )
      headers.delete("cookie");
    const forwarded = await copyRequest(request, headers);
    const response = await nativeRequest.run(native, () => auth.handler(forwarded));
    return response.status < 500
      ? response
      : failureResponse("auth.failed", new Error(await response.text()));
  }

  async function principal(headers: Headers) {
    const credentials = sessionCredentials(headers);
    if (credentials.kind === "bearer") {
      const session = await bearerSession(credentials.token);
      return session === null ? null : store.sessionPrincipal(session.session.id);
    }
    if (credentials.kind !== "cookie") return null;
    const session = await auth.api.getSession({ headers, query: { disableRefresh: true } });
    return session === null || session.session.isNative
      ? null
      : store.sessionPrincipal(session.session.id);
  }

  async function bearerSession(token: string | null) {
    if (token === null) return null;
    const session = await (await auth.$context).internalAdapter.findSession(token);
    return !session?.session.isNative || session.session.expiresAt <= new Date() ? null : session;
  }

  async function withoutToken(response: Response) {
    if (!response.ok) return response;
    const body: unknown = await response.json();
    if (body !== null && typeof body === "object") {
      if ("token" in body) delete body.token;
      if ("session" in body && body.session !== null && typeof body.session === "object") {
        if ("isNative" in body.session && body.session.isNative === true)
          return Response.json(null, { headers: { "cache-control": "no-store" } });
        if ("token" in body.session) delete body.session.token;
        if ("isNative" in body.session) delete body.session.isNative;
      }
    }
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return Response.json(body, { status: response.status, headers });
  }

  function withoutCookies(response: Response) {
    const headers = new Headers(response.headers);
    headers.delete("set-cookie");
    return new Response(response.body, { status: response.status, headers });
  }

  async function handle(incoming: Request): Promise<Response> {
    const request = await boundedRequest(incoming);
    if (request === null) return new Response(null, { status: 413 });
    const requestedPath = new URL(request.url).pathname.replace(/^\/api\/auth/, "");
    const native = nativeRoutes.has(requestedPath);
    const path = nativeRoutes.get(requestedPath) ?? requestedPath;
    const credentials = sessionCredentials(request.headers);
    if (native) {
      if (request.method !== "POST" || (path === "/demo" && !demo))
        return new Response(null, { status: 404 });
      if (["origin", "sec-fetch-site"].some((header) => request.headers.has(header)))
        return new Response(null, { status: 403 });
      if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
        return new Response(null, { status: 415 });
      if (path === "/sign-out") {
        const body: unknown = await request.json().catch(() => null);
        if (!SignOut.safeParse(body).success) return new Response(null, { status: 400 });
        const session = await bearerSession(
          credentials.kind === "bearer" ? credentials.token : null,
        );
        if (session === null) return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
        await (await auth.$context).internalAdapter.deleteSession(session.session.token);
        return Response.json({ success: true });
      }
    } else {
      if (path === "/sign-out" && (credentials.kind === "bearer" || credentials.kind === "refused"))
        return new Response(null, { status: 400 });
      if (credentials.kind === "refused") return new Response(null, { status: 403 });
    }
    if (path === "/get-session" && request.method === "GET" && credentials.kind === "bearer") {
      const current = await principal(request.headers);
      if (current?.kind !== "session")
        return Response.json(null, { headers: { "cache-control": "no-store" } });
      const profile = await store.sessionProfile(current.actor);
      return Response.json(
        {
          session: current.session,
          user: { id: profile.userId, name: profile.name, role: profile.role },
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (
      request.method === "POST" &&
      request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")
    ) {
      if (request.headers.get("origin") !== new URL(env.baseUrl).origin)
        return new Response(null, { status: 403 });
      const fields = new URLSearchParams(await request.text());
      const headers = new Headers(request.headers);
      headers.set("content-type", "application/json");
      headers.delete("content-length");
      const response = await handle(
        new Request(request.url, {
          method: "POST",
          headers,
          body: JSON.stringify(Object.fromEntries(fields)),
        }),
      );
      if (!response.ok) return response;
      const resultHeaders = new Headers(response.headers);
      resultHeaders.set("location", "/");
      resultHeaders.delete("content-type");
      return new Response(null, { status: 303, headers: resultHeaders });
    }
    if (path === "/demo") {
      if (!demo || request.method !== "POST") return new Response(null, { status: 404 });
      if (!native && request.headers.get("origin") !== new URL(env.baseUrl).origin)
        return new Response(null, { status: 403 });
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        return new Response(null, { status: 415 });
      if (
        !(await allowRequest(store, [
          { key: limitKey("demo:client", clientAddress(request, env.trustedProxyCount)), max: 20 },
          { key: "demo:global", max: env.globalLimit },
        ]))
      )
        return rateLimited();
      const body: unknown = await request
        .clone()
        .json()
        .catch(() => null);
      if (!DemoSignIn.safeParse(body).success) return new Response(null, { status: 400 });
      return dispatch(request, native);
    }
    if (path === "/get-session" && request.method === "GET")
      return withoutToken(
        await auth.api.getSession({
          headers: request.headers,
          query: { disableRefresh: true },
          asResponse: true,
        }),
      );
    if (path === "/sign-out" && request.method === "POST") return dispatch(request);
    const sending = path === "/email-otp/send-verification-otp";
    if (request.method !== "POST" || (!sending && path !== "/sign-in/email-otp")) {
      return new Response(null, { status: 404 });
    }
    if (!native && request.headers.get("origin") !== new URL(env.baseUrl).origin)
      return new Response(null, { status: 403 });
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      return new Response(null, { status: 415 });
    const body: unknown = await request.json().catch(() => null);
    const parsed = (sending ? (native ? NativeSendCode : SendCode) : SignIn).safeParse(body);
    if (!parsed.success)
      return Response.json({ error: "Invalid sign-in request." }, { status: 400 });
    const minimum = performance.now() + 300 + randomInt(0, 50);
    try {
      if (
        !(await allowRequest(store, [
          { key: limitKey("auth:client", clientAddress(request, env.trustedProxyCount)), max: 20 },
          { key: limitKey(sending ? "send" : "verify", parsed.data.email), max: sending ? 3 : 10 },
          { key: "auth:global", max: env.globalLimit },
        ]))
      )
        return rateLimited();
      const response = await dispatch(
        new Request(native ? new URL(`/api/auth${path}`, request.url) : request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(sending ? { ...parsed.data, type: "sign-in" } : parsed.data),
        }),
        native,
      );
      if (!native) return sending ? response : await withoutToken(response);
      if (sending || !response.ok) return withoutCookies(response);
      const result: unknown = await response.json();
      const token = z.object({ token: z.string() }).parse(result).token;
      const session = await bearerSession(token);
      if (session === null) throw new Error("Sign-in returned no session");
      const current = await store.sessionPrincipal(session.session.id);
      if (current === null) throw new Error("Sign-in returned no principal");
      return Response.json({
        token,
        expiresAt: session.session.expiresAt,
        user: { id: session.user.id, name: session.user.name, role: current.actor.role },
      });
    } finally {
      await sleep(Math.max(0, minimum - performance.now()));
    }
  }

  return {
    handle: (request: Request) => protectHttp("auth.failed", () => handle(request)),
    principal,
  };
}
export type Authentication = ReturnType<typeof createAuthentication>;
