import { describe, expect, it } from "vitest";
import { planDistribution, type DistributionLead } from "../src/index.ts";
import { ana, ben } from "./fixtures.ts";
import { LeadId } from "../src/ids.ts";

function lead(
  n: number,
  previousOwnerId: DistributionLead["lifecycle"]["previousOwnerId"] = null,
): DistributionLead {
  const id = LeadId.parse(`019a8e2c-0000-7000-8000-${String(n).padStart(12, "0")}`);
  if (!id) throw new Error("Invalid fixture ID");
  return {
    id,
    version: 0,
    lifecycle: { state: { status: "new" }, firstAssignedAt: null, previousOwnerId },
  };
}

describe("round-robin", () => {
  it("deals leads in turn, by user ID when queues are equal, without changing the input", () => {
    const leads = [lead(1), lead(2), lead(3)];
    const result = planDistribution(leads, [ana, ben], false, new Map());
    expect(result).toEqual({
      ok: true,
      value: [
        { leadId: leads[0]?.id, to: ana },
        { leadId: leads[1]?.id, to: ben },
        { leadId: leads[2]?.id, to: ana },
      ],
    });
    expect(leads.every((l) => l.lifecycle.state.status === "new")).toBe(true);
  });
  it("skips a previous owner and keeps dealing in turn", () => {
    const leads = [lead(1, ana.ownerId), lead(2)];
    expect(planDistribution(leads, [ana, ben], true, new Map())).toEqual({
      ok: true,
      value: [
        { leadId: leads[0]?.id, to: ben },
        { leadId: leads[1]?.id, to: ana },
      ],
    });
  });
  it("starts with the emptiest queue and gives each agent one lead per turn", () => {
    const leads = [lead(1), lead(2), lead(3)];
    expect(
      planDistribution(
        leads,
        [ana, ben],
        false,
        new Map([
          [ana.ownerId, 2],
          [ben.ownerId, 0],
        ]),
      ),
    ).toEqual({
      ok: true,
      value: [
        { leadId: leads[0]?.id, to: ben },
        { leadId: leads[1]?.id, to: ana },
        { leadId: leads[2]?.id, to: ben },
      ],
    });
  });
  it("breaks equal queue sizes by ascending user ID regardless of input order", () => {
    expect(planDistribution([lead(1)], [ben, ana], false, new Map())).toEqual({
      ok: true,
      value: [{ leadId: lead(1).id, to: ana }],
    });
  });
  it("refuses a lead with no eligible agent", () => {
    expect(planDistribution([lead(1, ana.ownerId)], [ana], true, new Map())).toEqual({
      ok: false,
      error: "noEligibleAgent",
    });
    expect(planDistribution([lead(1)], [], false, new Map())).toEqual({
      ok: false,
      error: "noEligibleAgent",
    });
  });
});
