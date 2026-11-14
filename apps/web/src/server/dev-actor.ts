import { UserId, type Actor } from "@relay/domain";

const DEV_USER_ID = "00000000-0000-7000-8000-000000000001";

/**
 * Stands in for the signed-in user until sessions exist. The lead list is scoped through it from
 * the start, so no unscoped query is ever written. Sessions replace this file and no query.
 */
export function devActor(): Actor {
  if (!UserId.is(DEV_USER_ID)) throw new Error("DEV_USER_ID is not a UUID");
  return { userId: DEV_USER_ID, role: "owner", team: null };
}
