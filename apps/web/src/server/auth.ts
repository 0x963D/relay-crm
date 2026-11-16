import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { parseEmail } from "@relay/domain";
import type { Store } from "@relay/store";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { z } from "zod";
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

type Schedule = (task: () => Promise<void>) => void;

export function createAuthentication(
  store: Store,
  env: AuthEnv,
  mailer: Mailer,
  schedule: Schedule,
) {
  const auth = betterAuth({
    appName: "Relay",
    baseURL: env.baseUrl,
    secret: env.secret,
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

  async function principal(headers: Headers) {
    if (!headers.has("cookie")) return null;
    const session = await auth.api.getSession({ headers });
    return session === null ? null : store.sessionPrincipal(session.session.id);
  }

  async function handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.replace(/^\/api\/auth/, "");
    if (path === "/get-session" && request.method === "GET") return auth.handler(request);
    if (path === "/sign-out" && request.method === "POST") return auth.handler(request);
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
      const response = await auth.handler(
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

  return { handle, principal };
}
export type Authentication = ReturnType<typeof createAuthentication>;
