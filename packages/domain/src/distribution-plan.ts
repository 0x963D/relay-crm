import { err, ok, type Result } from "./result.ts";
import type { AccessFailure, DistributionItem, DistributionLead } from "./distribution.ts";
import type { Assignment } from "./lead.ts";

export function planDistribution(
  leads: readonly DistributionLead[],
  agents: readonly Assignment[],
  excludePreviousOwner: boolean,
): Result<readonly DistributionItem[], AccessFailure> {
  const items: DistributionItem[] = [];
  let cursor = 0;
  for (const lead of leads) {
    let chosen: Assignment | undefined;
    for (let remaining = agents.length; remaining > 0; remaining -= 1) {
      const candidate = agents[cursor % agents.length];
      cursor += 1;
      if (
        candidate &&
        (!excludePreviousOwner || candidate.ownerId !== lead.lifecycle.previousOwnerId)
      ) {
        chosen = candidate;
        break;
      }
    }
    if (!chosen) return err("noEligibleAgent");
    items.push({ leadId: lead.id, to: chosen });
  }
  return ok(items);
}
