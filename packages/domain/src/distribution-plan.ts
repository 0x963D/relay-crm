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
  const open = (agent: Assignment): number => openLeadCounts.get(agent.ownerId) ?? 0;
  const turns = [...agents].sort((a, b) => open(a) - open(b) || a.ownerId.localeCompare(b.ownerId));
  let next = 0;
  for (const lead of leads) {
    let chosen: Assignment | undefined;
    for (let step = 0; step < turns.length && !chosen; step++) {
      const candidate = turns[(next + step) % turns.length];
      if (!candidate) continue;
      if (excludePreviousOwner && candidate.ownerId === lead.lifecycle.previousOwnerId) continue;
      chosen = candidate;
      next = (next + step + 1) % turns.length;
    }
    if (!chosen) return err("noEligibleAgent");
    items.push({ leadId: lead.id, to: chosen });
  }
  return ok(items);
}
