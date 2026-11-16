import type { Actor, Principal, AuditAction, AuditSubject, AuditCause } from "@relay/domain";
import type { Prisma } from "./generated/client.ts";
import type { Tx } from "./tx.ts";
import { InvariantError } from "./lead-row.ts";

export function auditActor(principal: Actor | Principal) {
  if ("kind" in principal) {
    if (principal.kind === "system") return { actorId: null, systemActor: principal.name };
    return { actorId: principal.actor.userId, systemActor: null };
  }
  return { actorId: principal.userId, systemActor: null };
}

function isJsonObject(value: unknown): value is Prisma.InputJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshot(value: object): Prisma.InputJsonObject {
  const json: unknown = JSON.parse(JSON.stringify(value));
  if (!isJsonObject(json)) throw new InvariantError("An audit snapshot must be a JSON object");
  return json;
}

export async function writeAudit(
  tx: Tx,
  principal: Actor | Principal,
  event: {
    readonly action: AuditAction;
    readonly subject: AuditSubject;
    readonly before: object;
    readonly after: object;
    readonly cause: AuditCause;
    readonly at: Date;
  },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      ...auditActor(principal),
      action: event.action,
      subjectType: event.subject.type,
      subjectId: event.subject.id,
      before: snapshot(event.before),
      after: snapshot(event.after),
      requestId: event.cause.kind === "idempotency" ? event.cause.requestId : event.cause.id,
      idempotencyId: event.cause.kind === "idempotency" ? event.cause.id : null,
      at: event.at,
    },
  });
}
