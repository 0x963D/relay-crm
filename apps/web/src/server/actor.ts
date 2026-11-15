import type { Actor, SessionPrincipal } from "@relay/domain";
import { headers } from "next/headers";
import { unauthorized } from "next/navigation";
import { composition, type Composition } from "./composition.ts";
import { devActor } from "./dev-actor.ts";

export async function resolvePrincipal(
  app: Pick<Composition, "auth" | "env" | "store">,
  requestHeaders: Headers,
): Promise<SessionPrincipal | null> {
  const principal = await app.auth?.principal(requestHeaders);
  if (principal) return principal;
  if (app.env.devRole === null) return null;
  const actor = devActor(app.env);
  await app.store.ensureDevelopmentActor(actor);
  return { kind: "development", actor };
}

export async function requireActor(): Promise<Actor> {
  const principal = await resolvePrincipal(composition(), await headers());
  if (!principal) unauthorized();
  return principal.actor;
}
