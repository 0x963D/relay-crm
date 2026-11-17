import { err, ok, type Result } from "./result.ts";
import type { AccessFailure, DistributionItem, DistributionLead } from "./distribution.ts";
import type { UserId } from "./ids.ts";
import type { Assignment } from "./lead.ts";

export function planDistribution(
  leads: readonly DistributionLead[],
  agents: readonly Assignment[],
  excludePreviousOwner: boolean,
  openLeadCounts: ReadonlyMap<UserId, number>,
): Result<readonly DistributionItem[], AccessFailure> {
  const items: DistributionItem[] = [];
  const counts = new Map(openLeadCounts);
  const ordered = [...agents].sort((a, b) => a.ownerId.localeCompare(b.ownerId));
  for (const lead of leads) {
    let chosen: Assignment | undefined;
    for (const candidate of ordered) {
      if (excludePreviousOwner && candidate.ownerId === lead.lifecycle.previousOwnerId) continue;
      if (!chosen || (counts.get(candidate.ownerId) ?? 0) < (counts.get(chosen.ownerId) ?? 0))
        chosen = candidate;
    }
    if (!chosen) return err("noEligibleAgent");
    counts.set(chosen.ownerId, (counts.get(chosen.ownerId) ?? 0) + 1);
    items.push({ leadId: lead.id, to: chosen });
  }
  return ok(items);
}
