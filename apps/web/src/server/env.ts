import { z } from "zod";

const Variables = z.object({
  DATABASE_URL: z.string({ error: "is required, such as postgresql://user:pass@localhost/relay" }),
  META_VERIFY_TOKEN: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_ACCESS_TOKEN: z.string().optional(),
  META_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, "must name a Graph API version, such as v24.0")
    .optional(),
  META_GRAPH_BASE_URL: z.url().default("https://graph.facebook.com"),
});

export interface MetaEnv {
  readonly verifyToken: string;
  readonly appSecret: string;
  readonly accessToken: string;
  readonly graphVersion: string;
  readonly graphBaseUrl: string;
}

export interface Env {
  readonly databaseUrl: string;
  /** null when Meta Lead Ads is not set up. The webhook then answers 404. */
  readonly meta: MetaEnv | null;
}

export class EnvError extends Error {
  override readonly name = "EnvError";
}

/** An empty variable, as a copied example file leaves it, counts as unset. */
function withoutEmpty(
  variables: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const set: Record<string, string> = {};
  for (const [name, value] of Object.entries(variables)) {
    if (value !== undefined && value.trim() !== "") set[name] = value;
  }
  return set;
}

/** Meta is configured as a whole or not at all, so a half-filled setup fails at startup. */
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

export function parseEnv(variables: Readonly<Record<string, string | undefined>>): Env {
  const parsed = Variables.safeParse(withoutEmpty(variables));
  if (!parsed.success) {
    throw new EnvError(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  return { databaseUrl: parsed.data.DATABASE_URL, meta: metaEnv(parsed.data) };
}

/** The one read of `process.env` in the application. Everything else takes an `Env`. */
export function readEnv(): Env {
  return parseEnv(process.env);
}
