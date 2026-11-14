import type { AccountId } from "./ids.ts";
import type { Assignment, LeadStatus, StateOf } from "./lead.ts";

export interface LeadStateSeed {
  readonly assignee: Assignment;
  readonly accountId: AccountId;
  readonly callBackAt: Date;
}

export type LeadStateExamples = { readonly [S in LeadStatus]: readonly StateOf<S>[] };

/**
 * Example lead states that cover every variant of every status. The return type is keyed by
 * status, so a new status does not compile until it has examples. Tests in other packages build
 * their fixtures from these, which keeps "every state" one list.
 */
export function leadStateExamples(seed: LeadStateSeed): LeadStateExamples {
  const { assignee, accountId, callBackAt } = seed;
  return {
    new: [{ status: "new" }],
    assigned: [{ status: "assigned", assignee }],
    working: [
      { status: "working", assignee, stage: { kind: "contacted" } },
      { status: "working", assignee, stage: { kind: "callBack", at: callBackAt } },
      { status: "working", assignee, stage: { kind: "noAnswer", count: 2 } },
    ],
    won: [{ status: "won", assignee, accountId }],
    lost: [
      { status: "lost", assignee, reason: "notInterested" },
      { status: "lost", assignee, reason: "badTiming" },
    ],
    dead: [
      { status: "dead", assignee, reason: "duplicate" },
      { status: "dead", assignee, reason: "wrongNumber" },
      { status: "dead", assignee, reason: "doNotContact" },
      { status: "dead", assignee: null, reason: "duplicate" },
      { status: "dead", assignee: null, reason: "doNotContact" },
    ],
  };
}
