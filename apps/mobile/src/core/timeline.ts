import type { IconName } from "./icons.ts";
import type { Lead } from "./api-types.ts";
import { contextualDate } from "./dates.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function channelPresentation(channel: string): { title: string; icon: IconName } {
  if (channel === "call") return { title: "Call attempt", icon: "phone" };
  if (channel === "whatsApp") return { title: "WhatsApp attempt", icon: "whatsapp" };
  return { title: "Attempt logged", icon: "phone" };
}
export function timelinePresentation(
  entry: Lead["timeline"][number],
  lead: Lead,
  person: string,
  now: Date,
  zone: string | undefined,
) {
  const detail = record(entry.detail);
  let title = "Status changed";
  let body = "";
  let icon: IconName = "history";
  if (entry.summary?.kind === "attempt") {
    title = channelPresentation(entry.summary.channel).title;
    body = entry.summary.note;
    icon = channelPresentation(entry.summary.channel).icon;
  } else if (entry.kind === "attempt") {
    title = "Attempt logged";
    icon = "phone";
  } else if (entry.summary?.kind === "note") {
    title = "Note added";
    body = entry.summary.note;
    icon = "note";
  } else if (entry.kind === "assignment") {
    const to = record(detail.to);
    const current = lead.timeline.find((activity) => activity.kind === "assignment");
    const holder =
      current?.id === entry.id && to.ownerId === lead.custody.heldBy?.id
        ? lead.custody.heldBy
        : null;
    title = holder ? `Assigned to ${holder.id === person ? "you" : holder.name}` : "Lead assigned";
    body = entry.actor
      ? record(record(detail.before).state).status === "new"
        ? "From the pool."
        : "The lead kept its history."
      : "Assignment recorded";
    icon = "person";
  } else if (entry.kind === "callback") {
    const change = record(detail.change);
    title = change.kind === "clear" ? "Callback cleared" : "Callback set";
    body =
      typeof change.at === "string"
        ? contextualDate(new Date(change.at), now, zone, "callback")
        : "";
    icon = "calendar";
  } else if (entry.kind === "closure") {
    const closing = record(detail.closing);
    title = `Closed as ${typeof closing.kind === "string" ? closing.kind : "recorded"}`;
    body =
      typeof closing.note === "string"
        ? closing.note
        : closing.reason === "duplicate"
          ? "Duplicate"
          : closing.reason === "wrongNumber"
            ? "Wrong number"
            : closing.reason === "doNotContact"
              ? "Do not contact"
              : "";
    icon = "done";
  } else if (entry.kind === "edit") {
    title = "Lead details changed";
    icon = "edit";
    const before = record(detail.before);
    const after = record(detail.after);
    const value = (v: unknown) => (typeof v === "string" ? v : "empty");
    body = ["name", "phone"]
      .filter((field) => before[field] !== after[field])
      .map((field) => `Changed ${field} from ${value(before[field])} to ${value(after[field])}.`)
      .join(" ");
  } else if (entry.kind === "intake") {
    title = "Lead received";
    icon = "inbox";
  }
  return {
    title,
    callback:
      entry.summary?.kind === "attempt" && entry.summary.callbackAt
        ? `Callback ${contextualDate(entry.summary.callbackAt, now, zone, "callback")}`
        : "",
    body,
    icon,
    actor: entry.actor ? (entry.actor.id === person ? "You" : entry.actor.name) : null,
    time: contextualDate(entry.at, now, zone, "timeline"),
  };
}
