import {
  AccountId,
  assigneeOf,
  IntakeEventId,
  LeadId,
  TeamId,
  UserId,
  type Assignment,
  type EventOf,
  type LeadEvent,
  type LeadEventType,
  type LeadLifecycle,
  type LeadState,
} from "../src/index.ts";
import { leadStateExamples } from "../src/testing.ts";

function must<T>(value: T | null): T {
  if (value === null) throw new Error("A fixture ID is not a UUID");
  return value;
}

export const NOW = new Date("2026-03-02T09:00:00.000Z");
export const EARLIER = new Date("2026-03-01T09:00:00.000Z");
export const LATER = new Date("2026-03-03T09:00:00.000Z");

const salesTeam = must(TeamId.parse("019a8e2c-0000-7000-8000-00000000000a"));
const otherTeam = must(TeamId.parse("019a8e2c-0000-7000-8000-00000000000b"));

export const ana: Assignment = {
  ownerId: must(UserId.parse("019a8e2c-0000-7000-8000-000000000001")),
  teamId: salesTeam,
};
export const ben: Assignment = {
  ownerId: must(UserId.parse("019a8e2c-0000-7000-8000-000000000002")),
  teamId: salesTeam,
};
export const anaOnOtherTeam: Assignment = { ownerId: ana.ownerId, teamId: otherTeam };

export const accountId = must(AccountId.parse("019a8e2c-0000-7000-8000-0000000000ac"));
export const leadId = must(LeadId.parse("019a8e2c-0000-7000-8000-0000000001ea"));
export const eventId = must(IntakeEventId.parse("019a8e2c-0000-7000-8000-0000000000e1"));

export const STATE_EXAMPLES = leadStateExamples({ assignee: ana, accountId, callBackAt: LATER });
export const ALL_STATES: readonly LeadState[] = Object.values(STATE_EXAMPLES).flat();

export const EVENT_EXAMPLES: { readonly [E in LeadEventType]: readonly EventOf<E>[] } = {
  assign: [{ type: "assign", to: ben }],
  returnToPool: [{ type: "returnToPool" }],
  logContact: [{ type: "logContact" }],
  scheduleCallBack: [{ type: "scheduleCallBack", at: LATER }],
  logNoAnswer: [{ type: "logNoAnswer" }],
  win: [{ type: "win", accountId }],
  lose: [{ type: "lose", reason: "noBudget" }],
  markDead: [
    { type: "markDead", reason: "duplicate" },
    { type: "markDead", reason: "wrongNumber" },
    { type: "markDead", reason: "doNotContact" },
  ],
  reopen: [{ type: "reopen", reason: { kind: "inbound", source: "webForm" } }],
};
export const ALL_EVENTS: readonly LeadEvent[] = Object.values(EVENT_EXAMPLES).flat();

export function lifecycleOf(state: LeadState): LeadLifecycle {
  return {
    state,
    firstAssignedAt: assigneeOf(state) === null ? null : EARLIER,
    previousOwnerId: null,
  };
}

export function describeState(state: LeadState): string {
  switch (state.status) {
    case "new":
    case "assigned":
    case "won":
      return state.status;
    case "working":
      return `working(${state.stage.kind})`;
    case "lost":
      return `lost(${state.reason})`;
    case "dead":
      return `dead(${state.reason}${state.assignee === null ? ", from the pool" : ""})`;
  }
}

export function describeEvent(event: LeadEvent): string {
  switch (event.type) {
    case "assign":
    case "returnToPool":
    case "logContact":
    case "scheduleCallBack":
    case "logNoAnswer":
    case "win":
    case "reopen":
      return event.type;
    case "lose":
    case "markDead":
      return `${event.type}(${event.reason})`;
  }
}
