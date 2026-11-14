import type { Actor } from "@relay/domain";
import { unauthorized } from "next/navigation";
import { composition } from "./composition.ts";
import { devActor } from "./dev-actor.ts";

export function requireActor(): Actor {
  const { env } = composition();
  if (env.devRole === null) unauthorized();
  return devActor(env);
}
