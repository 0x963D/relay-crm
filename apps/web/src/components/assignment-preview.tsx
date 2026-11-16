import type { RefObject } from "react";
import type { Outputs } from "@/lib/api";
import { assignmentKey, type Plan } from "@/lib/assignment";
import { callbackDate } from "@/lib/display";
import { cn } from "@/lib/utils";
import { Avatar, Refusal, Slip } from "./pieces";
import { Card } from "./ui/card";

export function StaleAssignment({
  plan,
  selectedCount,
  zone,
}: {
  plan: Extract<Plan, { kind: "stale" }>;
  selectedCount: number;
  zone: string;
}) {
  return (
    <Refusal announce={false} title="Nothing was assigned">
      <p>
        {plan.changed.length
          ? `${String(plan.changed.length)} of these ${String(selectedCount)} leads changed hands after your preview at ${callbackDate(plan.at, zone)}.`
          : "These leads changed or are no longer visible after your preview."}
      </p>
      {[
        ...Map.groupBy(
          plan.changed,
          (lead) =>
            `${lead.custody.assignedBy?.name ?? "A staff member"}|${lead.custody.heldBy?.name ?? ""}|${callbackDate(lead.custody.assignedBy?.at ?? null, zone)}`,
        ).entries(),
      ].map(([key, leads]) => {
        const [by, to, at] = key.split("|");
        return (
          <p key={key}>
            {by} assigned{" "}
            {new Intl.ListFormat("en-GB", {
              style: "long",
              type: "conjunction",
            }).format(leads.map((lead) => lead.name ?? "an unnamed lead"))}
            {to ? ` to ${to}` : ""} at {at}.
          </p>
        );
      })}
      <p>
        {plan.remaining.length === 0
          ? "No selected leads remain in the pool. Cancel this preview to choose other leads."
          : `${String(plan.remaining.length)} still ${plan.remaining.length === 1 ? "has" : "have"} no owner. Make a new preview to share them out.`}
      </p>
    </Refusal>
  );
}

export function AssignmentPreview({
  plan,
  recipients,
  zone,
  previewHeading,
}: {
  plan: Exclude<Plan, { kind: "editing" }>;
  recipients: Outputs["leads"]["agents"];
  zone: string;
  previewHeading: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <Card
      role="region"
      aria-label="Assignment preview"
      className={cn(
        "gap-0 overflow-hidden rounded-lg py-0 shadow-none",
        plan.kind === "stale" && "opacity-90",
      )}
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <h3 ref={previewHeading} tabIndex={-1} className="font-semibold">
          Preview
        </h3>
        <span className="text-xs text-secondary-foreground">
          made at {callbackDate(plan.at, zone)}
        </span>
        <Slip
          kind={plan.kind === "stale" ? "neutral" : "waiting"}
          icon={plan.kind === "stale" ? "history" : "wait"}
        >
          {plan.kind === "stale" ? "Out of date" : "Not assigned yet"}
        </Slip>
      </div>
      {recipients.map((agent) => {
        const items = plan.preview.items.filter(
          (item) => assignmentKey(item.to) === assignmentKey(agent),
        );
        return (
          <div key={assignmentKey(agent)} className="flex gap-2 border-t px-3 py-2">
            <Avatar name={agent.name} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-semibold">{agent.name}</span>
                <span className="text-caption text-secondary-foreground">
                  {items.length} {items.length === 1 ? "lead" : "leads"}
                </span>
              </div>
              <p className="text-caption text-secondary-foreground">
                {items
                  .map(
                    (item) =>
                      plan.rows.find((row) => row.id === item.leadId)?.name ?? "Unnamed lead",
                  )
                  .join(", ") || "None"}
              </p>
            </div>
          </div>
        );
      })}
    </Card>
  );
}
