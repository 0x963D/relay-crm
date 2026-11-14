import { UserId, type Actor } from "@relay/domain";
import type { Env } from "./env.ts";

const DEV_USER_ID = "00000000-0000-7000-8000-000000000001";

/**
 * Stands in for the signed-in user until sessions exist, and only where the environment grants
 * it. Everywhere else it is null, and `requireActor` answers that nobody is signed in.
 */
export function devActor(env: Pick<Env, "devRole">): Actor | null {
  if (env.devRole === null) return null;
  if (!UserId.is(DEV_USER_ID)) throw new Error("DEV_USER_ID is not a UUID");
  return { userId: DEV_USER_ID, role: env.devRole, team: null };
}
