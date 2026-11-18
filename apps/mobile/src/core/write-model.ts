import { z } from "zod";
import type { Operation, WriteState, WriteView } from "./write-machine.ts";

const instant = z.iso.datetime();
const change = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set"), at: instant }),
  z.object({ kind: z.literal("clear") }),
]);
const note = z.string().trim().min(1).max(4000);
const closing = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("won") }),
  z.object({ kind: z.literal("lost"), note }),
  z.object({
    kind: z.literal("dead"),
    reason: z.enum(["duplicate", "wrongNumber", "doNotContact"]),
  }),
]);
export const commandSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("attempt"),
    payload: z
      .object({
        id: z.string(),
        key: z.uuid(),
        channel: z.enum(["call", "whatsApp"]),
        outcome: z.enum(["noAnswer", "spokeToThem"]),
        note,
        callback: change.optional(),
      })
      .strict(),
  }),
  z.object({
    operation: z.literal("note"),
    payload: z.object({ id: z.string(), key: z.uuid(), note }).strict(),
  }),
  z.object({
    operation: z.literal("callback"),
    payload: z.object({ id: z.string(), key: z.uuid(), change }).strict(),
  }),
  z.object({
    operation: z.literal("close"),
    payload: z.object({ id: z.string(), key: z.uuid(), closing }).strict(),
  }),
]);
export type Command = z.infer<typeof commandSchema>;
export const handoffSchema = z.object({ channel: z.enum(["call", "whatsApp"]), at: instant });
export const draftSchema = z.object({
  operation: z.enum(["attempt", "note", "callback", "close"]),
  id: z.string(),
  leadName: z.string(),
  note: z.string().max(4000),
  channel: z.enum(["call", "whatsApp"]),
  outcome: z.enum(["noAnswer", "spokeToThem"]),
  callbackAt: instant.nullable(),
  closing: z.enum(["won", "lost", "dead"]).nullable(),
  reason: z.enum(["duplicate", "wrongNumber", "doNotContact"]).nullable(),
  handoff: handoffSchema.nullable(),
  changedAt: instant,
});
export type Draft = z.infer<typeof draftSchema>;
export const entrySchema = z.object({
  command: commandSchema,
  draft: draftSchema,
  status: z.enum(["sending", "neverSubmitted", "unknown", "refused", "notSaved"]),
  attempt: z.int().min(0),
  followsUnknown: z.boolean(),
  refusal: z.string().nullable(),
  savedAt: instant,
  unknownCause: z
    .enum(["network", "timeout", "unreadable", "server", "interrupted", "session"])
    .nullable(),
});
export type Entry = z.infer<typeof entrySchema>;
export const phoneSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), entrySchema),
  drafts: z.record(z.string(), draftSchema),
});
export type PhoneData = z.infer<typeof phoneSchema>;
export interface Scope {
  readonly server: string;
  readonly person: string;
}
export interface Receipt {
  readonly id: string;
  readonly accountId: string | null;
}
export const receiptSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1).nullable(),
});
export type Answer =
  | { readonly kind: "receipt"; readonly receipt: Receipt }
  | { readonly kind: "refused"; readonly reason: string | null }
  | { readonly kind: "401" }
  | {
      readonly kind: "unknown";
      readonly cause: "network" | "timeout" | "unreadable" | "server";
      readonly sessionEnded?: true;
    };
export interface WriteSnapshot {
  readonly state: WriteState;
  readonly view: WriteView;
  readonly entry: Entry | null;
  readonly storageError: "record" | "retry" | "remove" | null;
  readonly receipt: Receipt | null;
}
export const emptyPhone = (): PhoneData => ({ version: 1, entries: {}, drafts: {} });
export const draftKey = (id: string, operation: Operation) => JSON.stringify([id, operation]);
export const sameScope = (a: Scope | null, b: Scope) =>
  a?.server === b.server && a.person === b.person;
export function stateOf(entry: Entry): WriteState {
  if (entry.status === "sending") return entry.followsUnknown ? "sendingRetry" : "sendingFirst";
  if (entry.status === "refused") return entry.followsUnknown ? "refusedAfterUnknown" : "refused";
  return entry.status;
}
export function entryNote(entry: Entry) {
  const command = entry.command;
  return command.operation === "note" || command.operation === "attempt"
    ? command.payload.note
    : command.operation === "close" && command.payload.closing.kind === "lost"
      ? command.payload.closing.note
      : "";
}
