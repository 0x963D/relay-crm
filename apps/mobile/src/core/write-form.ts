import { AccountId, transition } from "@relay/domain";
import type { Lead } from "./api-types.ts";
import type { Command, Draft } from "./write-model.ts";
import type { Operation } from "./write-machine.ts";

export interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}
export function wallTime(at: Date, zone: string): WallTime {
  const fields = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const value = (name: string) => Number(fields.find((part) => part.type === name)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
}
const wallStamp = (wall: WallTime) =>
  Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
export function wallInstant(wall: WallTime, zone: string): Date | null {
  const stamp = wallStamp(wall);
  const offsets = new Set<number>();
  for (let hour = -36; hour <= 36; hour += 6) {
    const sample = stamp + hour * 3600000;
    offsets.add(wallStamp(wallTime(new Date(sample), zone)) - sample);
  }
  const matches = [...offsets]
    .map((offset) => stamp - offset)
    .filter((at) => wallStamp(wallTime(new Date(at), zone)) === stamp);
  return matches.length ? new Date(Math.min(...matches)) : null;
}
export function inOneHour(now: Date) {
  return new Date(Math.ceil((now.getTime() + 3600000) / 300000) * 300000);
}
export function callbackShortcuts(now: Date, zone: string) {
  const today = wallTime(now, zone);
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  return [
    { label: "In 1 hour", at: inOneHour(now) },
    { label: "Today 18:00", at: wallInstant({ ...today, hour: 18, minute: 0 }, zone) },
    {
      label: "Tomorrow 09:00",
      at: wallInstant(
        {
          year: tomorrow.getUTCFullYear(),
          month: tomorrow.getUTCMonth() + 1,
          day: tomorrow.getUTCDate(),
          hour: 9,
          minute: 0,
        },
        zone,
      ),
    },
  ].filter((item): item is { label: string; at: Date } => item.at !== null && item.at > now);
}
export function initialDraft(input: {
  id: string;
  name: string;
  operation: Operation;
  callback: Date | null;
  now: Date;
  channel?: "call" | "whatsApp";
}): Draft {
  const future = input.callback && input.callback > input.now ? input.callback : null;
  return {
    id: input.id,
    operation: input.operation,
    leadName: input.name,
    note: "",
    channel: input.channel ?? "call",
    outcome: "noAnswer",
    callbackAt:
      (input.operation === "callback"
        ? (future ?? inOneHour(input.now))
        : input.operation === "attempt"
          ? future
          : null
      )?.toISOString() ?? null,
    closing: null,
    reason: null,
    handoff: null,
    changedAt: input.now.toISOString(),
  };
}
export function appendQuickNote(note: string, phrase: string) {
  const trimmed = note.trimEnd();
  const next = `${trimmed}${trimmed ? (/[.!?]$/.test(trimmed) ? " " : ". ") : ""}${phrase}`;
  return next.trim().length <= 4000 ? next : null;
}
export function draftHasContent(draft: Draft, initial: Draft) {
  return ["note", "channel", "outcome", "callbackAt", "closing", "reason", "handoff"].some(
    (field) => {
      switch (field) {
        case "note":
          return draft.note !== initial.note;
        case "channel":
          return draft.channel !== initial.channel;
        case "outcome":
          return draft.outcome !== initial.outcome;
        case "callbackAt":
          return draft.callbackAt !== initial.callbackAt;
        case "closing":
          return draft.closing !== initial.closing;
        case "reason":
          return draft.reason !== initial.reason;
        case "handoff":
          return draft.handoff !== null;
        default:
          return false;
      }
    },
  );
}
export interface FormError {
  readonly field: "note" | "time" | "closing";
  readonly text: string;
}
export function formCommand(
  draft: Draft,
  key: string,
  now: Date,
  clear = false,
): Command | FormError {
  const note = draft.note.trim();
  const common = { id: draft.id, key };
  if (
    (draft.operation === "attempt" ||
      draft.operation === "note" ||
      (draft.operation === "close" && draft.closing === "lost")) &&
    !note
  )
    return {
      field: "note",
      text:
        draft.operation === "attempt"
          ? "Write a note before saving. A few words are enough."
          : draft.operation === "note"
            ? "Write the note before saving."
            : "Write a reason before closing.",
    };
  if (note.length > 4000) return { field: "note", text: "Keep it to 4,000 characters." };
  if (!clear && draft.callbackAt && new Date(draft.callbackAt) <= now)
    return { field: "time", text: "That is in the past. Choose a later one." };
  switch (draft.operation) {
    case "attempt":
      return {
        operation: "attempt",
        payload: {
          ...common,
          channel: draft.channel,
          outcome: draft.outcome,
          note,
          ...(draft.callbackAt ? { callback: { kind: "set", at: draft.callbackAt } } : {}),
        },
      };
    case "note":
      return { operation: "note", payload: { ...common, note } };
    case "callback":
      return clear
        ? { operation: "callback", payload: { ...common, change: { kind: "clear" } } }
        : draft.callbackAt
          ? {
              operation: "callback",
              payload: { ...common, change: { kind: "set", at: draft.callbackAt } },
            }
          : { field: "time", text: "Choose a callback time." };
    case "close":
      if (draft.closing === "won")
        return { operation: "close", payload: { ...common, closing: { kind: "won" } } };
      if (draft.closing === "lost")
        return { operation: "close", payload: { ...common, closing: { kind: "lost", note } } };
      if (draft.closing === "dead" && draft.reason)
        return {
          operation: "close",
          payload: { ...common, closing: { kind: "dead", reason: draft.reason } },
        };
      return { field: "closing", text: "Choose an outcome and its reason." };
  }
}
export function closingAvailability(
  lead: Lead,
  now: Date,
  refusal: "invalidTransition" | "wrongNumberNeedsAnAttempt" | null = null,
) {
  if (!["new", "assigned", "working", "won", "lost", "dead"].includes(lead.lifecycle.state.status))
    return { won: false, lost: false, duplicate: false, wrongNumber: false, doNotContact: false };
  const accountId = AccountId.parse("00000000-0000-4000-8000-000000000000");
  if (!accountId) throw new Error("Invalid account identifier.");
  const latestAssignment = lead.timeline
    .filter((item) => item.kind === "assignment")
    .reduce((sequence, item) => (item.sequence > sequence ? item.sequence : sequence), 0n);
  const hasAttempt = lead.timeline.some(
    (item) => item.kind === "attempt" && item.sequence > latestAssignment,
  );
  return {
    won:
      transition(lead.lifecycle, { type: "win", accountId }, now).ok &&
      refusal !== "invalidTransition",
    lost:
      transition(lead.lifecycle, { type: "lose", reason: "Reason" }, now).ok &&
      refusal !== "invalidTransition",
    duplicate: transition(
      lead.lifecycle,
      { type: "markDead", reason: "duplicate", hasAttempt },
      now,
    ).ok,
    wrongNumber:
      refusal !== "wrongNumberNeedsAnAttempt" &&
      transition(lead.lifecycle, { type: "markDead", reason: "wrongNumber", hasAttempt }, now).ok,
    doNotContact: transition(
      lead.lifecycle,
      { type: "markDead", reason: "doNotContact", hasAttempt },
      now,
    ).ok,
  };
}
