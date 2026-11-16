import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { parseEmail } from "@relay/domain";
import type { Store } from "@relay/store";
import { DEMO_ROLES } from "@relay/store";
import { createAuthEndpoint, APIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { z } from "zod";
import { boundedRequest } from "./http.ts";
import { failureResponse, protectHttp } from "./errors.ts";
import { clientAddress } from "./client-address.ts";
import { allowRequest, limitKey, rateLimited } from "./rate-limit.ts";
import type { AuthEnv } from "./env.ts";
import type { Mailer } from "./mailer.ts";

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
const SignIn = z.object({ email: Email, otp: z.string().regex(/^\d{6}$/) }).strict();
const DemoSignIn = z.object({ role: z.enum(DEMO_ROLES) }).strict();

type Schedule = (task: () => Promise<void>) => void;

export function createAuthentication(
  store: Store,
  env: AuthEnv,
  mailer: Mailer,
  schedule: Schedule,
  demo = false,
) {
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
            data: { ...session, currentTeamId: await store.initialSessionTeam(session.userId) },
          }),
        },
      },
    },
    user: { modelName: "user" },
    session: {
      modelName: "authSession",
      expiresIn: 60 * 60 * 24,
      cookieCache: { enabled: false },
      additionalFields: { currentTeamId: { type: "string", required: false, input: false } },
    },
    account: { modelName: "authAccount" },
    verification: { modelName: "authVerification" },
    advanced: { database: { generateId: () => randomUUID() }, cookiePrefix: "relay" },
    rateLimit: { enabled: false },
    plugins: [
      {
        id: "demo-sign-in",
        endpoints: {
          demoSignIn: createAuthEndpoint(
            "/demo",
            {
              method: "POST",
              body: DemoSignIn,
            },
            async (ctx) => {
              if (!demo) throw new APIError("NOT_FOUND");
              const user = await store.demoPerson(ctx.body.role);
              const session = await ctx.context.internalAdapter.createSession(user.id);
              await setSessionCookie(ctx, { session, user });
              return ctx.json({
                session: { id: session.id, expiresAt: session.expiresAt },
                user: { id: user.id, name: user.name, role: user.role },
                roles: DEMO_ROLES,
              });
            },
          ),
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

  async function dispatch(request: Request): Promise<Response> {
    const response = await auth.handler(request);
    return response.status < 500
      ? response
      : failureResponse("auth.failed", new Error(await response.text()));
  }

  async function principal(headers: Headers) {
    if (!headers.has("cookie")) return null;
    const session = await auth.api.getSession({ headers });
    return session === null ? null : store.sessionPrincipal(session.session.id);
  }

  async function handle(incoming: Request): Promise<Response> {
    const request = await boundedRequest(incoming);
    if (request === null) return new Response(null, { status: 413 });
    const path = new URL(request.url).pathname.replace(/^\/api\/auth/, "");
    if (path === "/demo") {
      if (!demo || request.method !== "POST") return new Response(null, { status: 404 });
      if (request.headers.get("origin") !== new URL(env.baseUrl).origin)
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
      return dispatch(request);
    }
    if (path === "/get-session" && request.method === "GET") return dispatch(request);
    if (path === "/sign-out" && request.method === "POST") return dispatch(request);
    const sending = path === "/email-otp/send-verification-otp";
    if (request.method !== "POST" || (!sending && path !== "/sign-in/email-otp")) {
      return new Response(null, { status: 404 });
    }
    if (request.headers.get("origin") !== new URL(env.baseUrl).origin)
      return new Response(null, { status: 403 });
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      return new Response(null, { status: 415 });
    const body: unknown = await request.json().catch(() => null);
    const parsed = (sending ? SendCode : SignIn).safeParse(body);
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
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(parsed.data),
        }),
      );
      return response;
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
