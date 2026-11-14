import type { Actor } from "@relay/domain";
import { unauthorized } from "next/navigation";
import { composition } from "./composition.ts";
import { devActor } from "./dev-actor.ts";

/**
 * The one way a page or a route gets an actor. With no session it never falls back to anyone. A
 * route answers 401, and a page renders app/unauthorized.tsx with status 401.
 */
export function requireActor(): Actor {
  return devActor(composition().env) ?? unauthorized();
}
