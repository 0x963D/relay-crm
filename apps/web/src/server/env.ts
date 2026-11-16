import { ROLES, type Role } from "@relay/domain";
import { z } from "zod";

const EXAMPLE_AUTH_SECRET = "example-only-do-not-use-this-secret";

const Variables = z.object({
  RELAY_OUTBOX_SECRET: z.string().min(32).optional(),
  RELAY_SANDBOX: z.literal("1").optional(),
  RELAY_SANDBOX_URL: z.url().optional(),
  RELAY_PAYMENT_WEBHOOK_SECRET: z.string().min(32).optional(),
  RELAY_RECONCILE_SECRET: z.string().min(32).optional(),
  RELAY_RECONCILE_FIRST_MS: z.coerce.number().int().min(0).max(86400000).default(900000),
  RELAY_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1000).max(86400000).default(300000),
  RELAY_SANDBOX_LATE_MS: z.coerce.number().int().min(0).max(60000).default(30000),
  AUTH_SECRET: z
    .string()
    .min(32)
    .refine((value) => new Set(value).size >= 12, "must contain at least 12 distinct characters")
    .refine((value) => value !== EXAMPLE_AUTH_SECRET, "must not use the secret from .env.example")
    .optional(),
  AUTH_URL: z.url().optional(),
  RELAY_AUTH_GLOBAL_LIMIT: z.coerce.number().int().min(21).max(1_000_000).default(10_000),
  SMTP_URL: z.url().optional(),
  SMTP_FROM: z.email().optional(),
  DATABASE_URL: z.string({ error: "is required, such as postgresql://user:pass@localhost/relay" }),
  META_VERIFY_TOKEN: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_ACCESS_TOKEN: z.string().optional(),
  META_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, "must name a Graph API version, such as v24.0")
    .optional(),
  META_GRAPH_BASE_URL: z.url().default("https://graph.facebook.com"),
  NODE_ENV: z.string().optional(),
  RELAY_TRUSTED_PROXY_COUNT: z.coerce.number().int().min(0).max(32).default(0),
  RELAY_DEV_ACTOR: z
    .literal("1", { error: "must be 1 to turn the dev actor on, or unset" })
    .optional(),
  RELAY_DEV_ROLE: z.enum(ROLES, { error: `must be one of ${ROLES.join(", ")}` }).default("agent"),
});

export interface MetaEnv {
  readonly verifyToken: string;
  readonly appSecret: string;
  readonly accessToken: string;
  readonly graphVersion: string;
  readonly graphBaseUrl: string;
}

export interface AuthEnv {
  readonly trustedProxyCount: number;
  readonly globalLimit: number;
  readonly secret: string;
  readonly baseUrl: string;
  readonly delivery:
    | { readonly kind: "smtp"; readonly url: string; readonly from: string }
    | { readonly kind: "developmentConsole" };
}

export interface PaymentEnv {
  readonly baseUrl: string;
  readonly webhookSecret: string;
  readonly reconcileSecret: string;
  readonly firstCheckMs: number;
  readonly intervalMs: number;
  readonly lateMs: number;
}

export interface Env {
  readonly outboxSecret: string | null;
  readonly payments: PaymentEnv | null;
  readonly trustedProxyCount: number;
  readonly auth: AuthEnv | null;
  readonly databaseUrl: string;
  readonly meta: MetaEnv | null;
  readonly devRole: Role | null;
}

export class EnvError extends Error {
  override readonly name = "EnvError";
}

function withoutEmpty(
  variables: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const set: Record<string, string> = {};
  for (const [name, value] of Object.entries(variables)) {
    if (value !== undefined && value.trim() !== "") set[name] = value;
  }
  return set;
}

function metaEnv(variables: z.infer<typeof Variables>): MetaEnv | null {
  const required = {
    META_VERIFY_TOKEN: variables.META_VERIFY_TOKEN,
    META_APP_SECRET: variables.META_APP_SECRET,
    META_ACCESS_TOKEN: variables.META_ACCESS_TOKEN,
    META_GRAPH_VERSION: variables.META_GRAPH_VERSION,
  };
  const {
    META_VERIFY_TOKEN: verifyToken,
    META_APP_SECRET: appSecret,
    META_ACCESS_TOKEN: accessToken,
    META_GRAPH_VERSION: graphVersion,
  } = required;

  if (
    verifyToken === undefined ||
    appSecret === undefined ||
    accessToken === undefined ||
    graphVersion === undefined
  ) {
    const missing = Object.entries(required)
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    if (missing.length === Object.keys(required).length) return null;
    throw new EnvError(
      `Meta Lead Ads is partly configured. Set ${missing.join(", ")}, or unset the other META_ variables.`,
    );
  }
  return {
    verifyToken,
    appSecret,
    accessToken,
    graphVersion,
    graphBaseUrl: variables.META_GRAPH_BASE_URL,
  };
}

function authEnv(v: z.infer<typeof Variables>): AuthEnv | null {
  if (!v.AUTH_SECRET && !v.AUTH_URL && !v.SMTP_URL && !v.SMTP_FROM) return null;
  if (!v.AUTH_SECRET || !v.AUTH_URL) throw new EnvError("Sign-in needs AUTH_SECRET and AUTH_URL.");
  const smtp =
    v.SMTP_URL && v.SMTP_FROM
      ? ({ kind: "smtp", url: v.SMTP_URL, from: v.SMTP_FROM } as const)
      : null;
  if ((v.SMTP_URL || v.SMTP_FROM) && !smtp)
    throw new EnvError("SMTP needs SMTP_URL and SMTP_FROM.");
  if (!smtp && v.NODE_ENV !== "development")
    throw new EnvError("Sign-in outside development needs SMTP.");
  return {
    trustedProxyCount: v.RELAY_TRUSTED_PROXY_COUNT,
    globalLimit: v.RELAY_AUTH_GLOBAL_LIMIT,
    secret: v.AUTH_SECRET,
    baseUrl: v.AUTH_URL,
    delivery: smtp ?? { kind: "developmentConsole" },
  };
}

export function parseEnv(
  variables: Readonly<Record<string, string | undefined>>,
  developmentBuild = process.env.RELAY_DEVELOPMENT_BUILD === "true",
): Env {
  const parsed = Variables.safeParse(withoutEmpty(variables));
  if (!parsed.success) {
    throw new EnvError(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const { DATABASE_URL, NODE_ENV, RELAY_DEV_ACTOR, RELAY_DEV_ROLE } = parsed.data;
  if (RELAY_DEV_ACTOR && !developmentBuild)
    throw new EnvError(
      "RELAY_DEV_ACTOR is forbidden in a production build. Unset it before starting the server.",
    );
  return {
    outboxSecret: parsed.data.RELAY_OUTBOX_SECRET ?? null,
    payments: paymentEnv(parsed.data),
    trustedProxyCount: parsed.data.RELAY_TRUSTED_PROXY_COUNT,
    auth: authEnv(parsed.data),
    databaseUrl: DATABASE_URL,
    meta: metaEnv(parsed.data),
    devRole:
      developmentBuild && NODE_ENV === "development" && RELAY_DEV_ACTOR === "1"
        ? RELAY_DEV_ROLE
        : null,
  };
}

export function readEnv(developmentBuild?: boolean): Env {
  return parseEnv(process.env, developmentBuild);
}

export function serverOptions() {
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(process.env.PORT ?? "3000");
  const dev = process.argv.includes("--dev");
  Object.assign(process.env, { NODE_ENV: dev ? "development" : "production" });
  return { port, dev };
}

function paymentEnv(v: z.infer<typeof Variables>): PaymentEnv | null {
  if (!v.RELAY_SANDBOX) return null;
  if (!v.RELAY_SANDBOX_URL || !v.RELAY_PAYMENT_WEBHOOK_SECRET || !v.RELAY_RECONCILE_SECRET)
    throw new EnvError(
      "Sandbox payments need RELAY_SANDBOX_URL, RELAY_PAYMENT_WEBHOOK_SECRET and RELAY_RECONCILE_SECRET.",
    );
  const url = new URL(v.RELAY_SANDBOX_URL);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new EnvError("RELAY_SANDBOX_URL must be an HTTP origin.");
  return {
    baseUrl: url.origin,
    webhookSecret: v.RELAY_PAYMENT_WEBHOOK_SECRET,
    reconcileSecret: v.RELAY_RECONCILE_SECRET,
    firstCheckMs: v.RELAY_RECONCILE_FIRST_MS,
    intervalMs: v.RELAY_RECONCILE_INTERVAL_MS,
    lateMs: v.RELAY_SANDBOX_LATE_MS,
  };
}
