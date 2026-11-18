import type { Queue, QueueRow } from "./api-types.ts";
import { clock, contextualDate, overdue } from "./dates.ts";

export const GROUPS = [
  { key: "overdueCallbacks", title: "Overdue callbacks", caption: "", empty: "Nothing is late." },
  { key: "dueToday", title: "Due today", caption: "", empty: "Nothing else today." },
  {
    key: "noCallbackSet",
    title: "No callback set",
    caption: "Tried at least once",
    empty: "Every tried lead has one.",
  },
  {
    key: "notYetCalled",
    title: "Assigned to you, not yet called",
    caption: "Newest first",
    empty: "Everything here has been tried.",
  },
  {
    key: "later",
    title: "Later",
    caption: "Callback after today, soonest first",
    empty: "Nothing booked after today.",
  },
] as const;
export type GroupKey = (typeof GROUPS)[number]["key"];
export type SlipKind = "refused" | "wait" | "fresh" | "outline" | "mute" | "done";
export interface RowSlip {
  readonly text: string;
  readonly kind: SlipKind;
  readonly icon: "alarm" | "clock" | "calendar" | "person" | "check" | "missed" | "phone";
}

const SOURCE_LABELS = new Map([
  ["metaLeadAds", "Meta Lead Ads"],
  ["webForm", "Web form"],
  ["csv", "CSV import"],
  ["manual", "Manual entry"],
]);
export function attemptOutcome(outcome: string, count: number): RowSlip {
  if (outcome === "spokeToThem") return { text: "Spoke to them", kind: "mute", icon: "check" };
  if (outcome === "noAnswer")
    return { text: `No answer ×${String(count)}`, kind: "mute", icon: "missed" };
  return { text: "Attempt logged", kind: "mute", icon: "phone" };
}
export function sourceLabel(source: string | null): string {
  return source === null ? "Unknown source" : (SOURCE_LABELS.get(source) ?? "Unknown source");
}

export function rowPresentation(row: QueueRow, group: GroupKey, now: Date, zone: string) {
  const slips: RowSlip[] = [];
  const last = row.lastNoteOrOutcome;
  if (group === "overdueCallbacks" && row.callbackAt)
    slips.push({ text: overdue(row.callbackAt, now, zone), kind: "refused", icon: "alarm" });
  if (group === "dueToday" && row.callbackAt)
    slips.push({ text: clock(row.callbackAt, zone), kind: "wait", icon: "clock" });
  if (group === "later" && row.callbackAt)
    slips.push({
      text: contextualDate(row.callbackAt, now, zone, "callback"),
      kind: "outline",
      icon: "calendar",
    });
  if (group === "notYetCalled") slips.push({ text: "New to you", kind: "fresh", icon: "person" });
  if (group === "noCallbackSet")
    slips.push(
      last?.kind === "attempt"
        ? attemptOutcome(last.outcome, row.noAnswerCount)
        : { text: "Attempt logged", kind: "mute", icon: "phone" },
    );
  if (row.noAnswerCount > 0 && !slips.some((slip) => slip.icon === "missed"))
    slips.push({ text: `No answer ×${String(row.noAnswerCount)}`, kind: "mute", icon: "missed" });
  const campaign = row.campaign?.split(" · ")[0] ?? "No campaign";
  const note = last?.kind === "attempt" || last?.kind === "note" ? last.note.trim() : "";
  const routine =
    last?.kind === "attempt" &&
    last.outcome === "noAnswer" &&
    [
      "no answer",
      "rang out",
      "left a voicemail",
      "line busy",
      "message sent, no reply",
      "one tick only",
    ].includes(note.replace(/\.$/, "").toLowerCase());
  const line =
    group === "notYetCalled"
      ? `${campaign}${row.assignedAt ? ` · Assigned ${contextualDate(row.assignedAt, now, zone, "checked")}` : ""} · ${sourceLabel(row.source)}`
      : routine
        ? campaign
        : `${campaign} · ${note || "No note yet"}`;
  return {
    name: row.name ?? row.email,
    slips,
    line,
    label: `${row.name ?? row.email}. ${group === "overdueCallbacks" ? "Overdue " : ""}${slips.map((s) => s.text).join(". ")}. ${campaign}. Last note: ${note || "No note yet"}.`,
  };
}

export function queueSections(queue: Queue) {
  return GROUPS.map((group) => ({
    ...group,
    count: queue.counts[group.key],
    rows: queue[group.key],
  }));
}
