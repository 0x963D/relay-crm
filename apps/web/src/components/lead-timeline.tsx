import { DEAD_REASONS } from "@relay/domain";
import { attemptOutcomes, deadReasons } from "@/lib/display";
import type { Outputs } from "@/lib/api";
import { shortDate, sourceLabel, callbackDate } from "@/lib/display";
import type { IconName } from "./icons";
import { Timeline, TimelineEntry } from "./timeline";
import { Slip } from "./pieces";
type Lead = Outputs["leads"]["get"];
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}
function timelineEntry(
  entry: Lead["timeline"][number],
  zone: string,
  lead: Lead,
): { title: string; body: string; icon: IconName } {
  const detail = object(entry.detail);
  if (entry.summary?.kind === "attempt")
    return {
      title: entry.summary.channel === "call" ? "Call attempt" : "WhatsApp attempt",
      body: entry.summary.note,
      icon: entry.summary.channel === "call" ? "call" : "whatsapp",
    };
  if (entry.summary?.kind === "note")
    return { title: "Note added", body: entry.summary.note, icon: "edit" };
  if (entry.kind === "assignment") {
    const to = object(detail?.to);
    const holder = to?.ownerId === lead.custody.heldBy?.id ? lead.custody.heldBy?.name : null;
    const fromPool = object(object(detail?.before)?.state)?.status === "new";
    return {
      title: holder ? `Assigned to ${holder}` : "Lead assigned",
      body: entry.actor
        ? `By ${entry.actor.name}${fromPool ? ", from the lead pool." : ". The lead kept its history."}`
        : "Assignment recorded",
      icon: "assign",
    };
  }
  if (entry.kind === "callback") {
    const change = object(detail?.change);
    const at = change?.at;
    return {
      title: change?.kind === "clear" ? "Callback cleared" : "Callback set",
      body: typeof at === "string" ? shortDate(new Date(at), zone) : "",
      icon: "callback",
    };
  }
  if (entry.kind === "closure") {
    const closing = object(detail?.closing);
    const reason = DEAD_REASONS.find((reason) => reason === closing?.reason);
    return {
      title: `Closed as ${typeof closing?.kind === "string" ? closing.kind : "recorded"}`,
      body:
        typeof closing?.note === "string"
          ? closing.note
          : typeof closing?.reason === "string"
            ? reason
              ? deadReasons[reason]
              : "Reason recorded"
            : "",
      icon: "done",
    };
  }
  return {
    title: entry.kind === "intake" ? "Lead received" : "Status changed",
    body:
      entry.kind === "intake"
        ? `${sourceLabel(lead.source)}${lead.attribution?.campaign ? ` · ${lead.attribution.campaign}` : ""}`
        : "",
    icon: entry.kind === "intake" ? "inbox" : "history",
  };
}

export function LeadTimeline({ lead, zone, limit }: { lead: Lead; zone: string; limit: number }) {
  return (
    <Timeline name="Lead history">
      {lead.timeline.slice(0, limit).map((entry) => {
        const display = timelineEntry(entry, zone, lead);
        return (
          <TimelineEntry key={entry.id} icon={display.icon}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{display.title}</span>
              {entry.summary?.kind === "attempt" && (
                <Slip icon={entry.summary.outcome === "noAnswer" ? "missed" : "check"}>
                  {entry.summary.outcome === "noAnswer"
                    ? `${attemptOutcomes.noAnswer} ×${String(entry.summary.noAnswerCount ?? 1)}`
                    : attemptOutcomes.spokeToThem}
                </Slip>
              )}
              {entry.summary?.kind === "attempt" && entry.summary.callbackAt && (
                <Slip kind="outline" icon="callback">
                  Callback {callbackDate(entry.summary.callbackAt, zone)}
                </Slip>
              )}
              <time
                className="text-xs text-muted-foreground @xl/detail:ms-auto"
                dateTime={entry.at.toISOString()}
              >
                {callbackDate(entry.at, zone)}
              </time>
            </div>
            {display.body && (
              <p className="mt-1 whitespace-pre-wrap break-words text-secondary-foreground">
                {display.body}
              </p>
            )}
            {entry.actor && entry.kind !== "assignment" && (
              <p className="mt-1 text-caption text-muted-foreground">{entry.actor.name}</p>
            )}
          </TimelineEntry>
        );
      })}
    </Timeline>
  );
}
