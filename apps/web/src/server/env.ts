import { z } from "zod";

const Variables = z.object({
  DATABASE_URL: z.string({ error: "is required, such as postgresql://user:pass@localhost/relay" }),
});

export interface Env {
  readonly databaseUrl: string;
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

export class EnvError extends Error {
  override readonly name = "EnvError";
}

export function parseEnv(variables: Readonly<Record<string, string | undefined>>): Env {
  const parsed = Variables.safeParse(withoutEmpty(variables));
  if (!parsed.success) {
    throw new EnvError(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  return { databaseUrl: parsed.data.DATABASE_URL };
}

/** The one read of `process.env` in the application. Everything else takes an `Env`. */
export function readEnv(): Env {
  return parseEnv(process.env);
}
