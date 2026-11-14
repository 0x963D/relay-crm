import { UserId, type Actor } from "@relay/domain";
import type { Env } from "./env.ts";

const DEV_USER_ID = "00000000-0000-7000-8000-000000000001";

export function devActor(env: Pick<Env, "devRole">): Actor {
  if (env.devRole === null) {
    throw new Error("devActor needs NODE_ENV=development and RELAY_DEV_ACTOR=1");
  }
  if (!UserId.is(DEV_USER_ID)) throw new Error("DEV_USER_ID is not a UUID");
  return { userId: DEV_USER_ID, role: env.devRole, team: null };
}
