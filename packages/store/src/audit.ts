import type { Actor, Principal } from "@relay/domain";

export function auditActor(principal: Actor | Principal) {
  if ("kind" in principal) {
    if (principal.kind === "system") return { actorId: null, systemActor: principal.name };
    return { actorId: principal.actor.userId, systemActor: null };
  }
  return { actorId: principal.userId, systemActor: null };
}
