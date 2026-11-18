import { LeadId, UserId, TeamId, parseEmail } from "@relay/domain";
import type { Queue, QueueRow } from "../src/core/api-types.ts";

export const at = new Date("2026-11-16T14:00:00Z");
const id = LeadId.parse("10000000-0000-4000-8000-000000000001");
const user = UserId.parse("20000000-0000-4000-8000-000000000001");
const team = TeamId.parse("30000000-0000-4000-8000-000000000001");
const email = parseEmail("lead@example.com");
if (!id || !user || !team || !email.ok) throw new Error("Invalid fixture identity.");
export const row: QueueRow = {
  id,
  name: "Hye-jin Park",
  email: email.value,
  phone: "+44 7700 900141",
  source: "metaLeadAds",
  lifecycle: {
    state: { status: "assigned", assignee: { ownerId: user, teamId: team } },
    firstAssignedAt: at,
    previousOwnerId: null,
  },
  createdAt: at,
  assignedAt: at,
  assignmentSequence: 1n,
  campaign: "IELTS evening · January intake",
  callbackAt: null,
  noAnswerCount: 0,
  hasAttempt: false,
  lastNoteOrOutcome: null,
};
export function queue(overrides: Partial<Queue> = {}): Queue {
  return {
    overdueCallbacks: [],
    dueToday: [],
    noCallbackSet: [],
    notYetCalled: [row],
    later: [],
    counts: { overdueCallbacks: 0, dueToday: 0, noCallbackSet: 0, notYetCalled: 1, later: 0 },
    at,
    timeZone: "Europe/London",
    nextCallbackAt: null,
    ...overrides,
  };
}
