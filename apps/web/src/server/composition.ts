import { openStore, type Store } from "@relay/store";
import { readEnv, type Env } from "./env.ts";

/** Every long-lived object the application has. This file is the only one that builds any. */
export interface Composition {
  readonly store: Store;
}

function compose(env: Env): Composition {
  return { store: openStore({ connectionString: env.databaseUrl }) };
}

declare global {
  var relayComposition: Composition | undefined;
}

/**
 * Builds the composition on first use, so importing a route reads no environment and opens no
 * pool, and `next build` needs no database. It is kept on `globalThis` because Next.js can load
 * this module more than once in one process, and each copy would otherwise open its own pool.
 */
export function composition(): Composition {
  return (globalThis.relayComposition ??= compose(readEnv()));
}
