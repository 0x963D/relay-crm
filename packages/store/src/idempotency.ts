import { createHash, randomUUID } from "node:crypto";
import type { Actor, Principal, JsonValue } from "@relay/domain";
import { auditActor } from "./audit.ts";
import { AccessError } from "./errors.ts";
import type { Prisma } from "./generated/client.ts";
import type { Tx } from "./tx.ts";

function isArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (isArray(value)) return `[${value.map((v) => canonical(v)).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

export function requestHash(request: Readonly<Record<string, JsonValue>>): string {
  return createHash("sha256").update(canonical(request)).digest("hex");
}

export async function idempotent<T>(
  tx: Tx,
  principal: Actor | Principal,
  input: {
    readonly key: string;
    readonly operation: string;
    readonly request: Readonly<Record<string, JsonValue>>;
  },
  decode: (stored: unknown) => T,
  execute: (id: string) => Promise<Prisma.InputJsonObject>,
): Promise<T> {
  const actor = auditActor(principal);
  const scope = actor.actorId === null ? `system:${actor.systemActor}` : `user:${actor.actorId}`;
  const hash = requestHash(input.request);
  const prior = await tx.idempotencyRecord.findUnique({
    where: { scope_key: { scope, key: input.key } },
  });
  if (prior) {
    if (prior.requestHash !== hash || prior.operation !== input.operation)
      throw new AccessError("idempotencyConflict");
    return decode(prior.result);
  }
  const id = randomUUID();
  const result = await execute(id);

  const stored = await tx.idempotencyRecord.create({
    data: { id, scope, key: input.key, operation: input.operation, requestHash: hash, result },
  });
  return decode(stored.result);
}
