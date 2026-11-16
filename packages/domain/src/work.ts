import type { DeadReason, LostReason } from "./lead.ts";

export const ATTEMPT_CHANNELS = ["call", "whatsApp"] as const;
export const ATTEMPT_OUTCOMES = ["noAnswer", "spokeToThem"] as const;

export type CallbackChange =
  { readonly kind: "set"; readonly at: Date } | { readonly kind: "clear" };

export interface Attempt {
  readonly channel: (typeof ATTEMPT_CHANNELS)[number];
  readonly outcome: (typeof ATTEMPT_OUTCOMES)[number];
  readonly note: string;
  readonly callback?: CallbackChange;
}

export type ClosingReason =
  | { readonly kind: "won" }
  | { readonly kind: "lost"; readonly reason: LostReason; readonly note: string }
  | { readonly kind: "dead"; readonly reason: DeadReason };

export type LeadWork =
  | { readonly kind: "attempt"; readonly attempt: Attempt }
  | { readonly kind: "note"; readonly note: string }
  | { readonly kind: "callback"; readonly change: CallbackChange }
  | { readonly kind: "close"; readonly closing: ClosingReason };

export type QueueGroup = "overdueCallbacks" | "dueToday" | "notYetCalled";

function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export function queueGroup(
  lead: { readonly callbackAt: Date | null; readonly hasAttempt: boolean },
  at: Date,
  timeZone: string,
): QueueGroup | null {
  if (lead.callbackAt !== null) {
    if (lead.callbackAt < at) return "overdueCallbacks";
    if (localDay(lead.callbackAt, timeZone) === localDay(at, timeZone)) return "dueToday";
    return null;
  }
  return lead.hasAttempt ? null : "notYetCalled";
}
