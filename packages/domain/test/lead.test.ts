import { describe, expect, it } from "vitest";
import {
  assigneeOf,
  isOpen,
  transition,
  type LeadEvent,
  type LeadEventType,
  type LeadLifecycle,
  type LeadState,
  type LeadStatus,
} from "../src/index.ts";
import {
  accountId,
  ALL_EVENTS,
  ALL_STATES,
  ana,
  anaOnOtherTeam,
  ben,
  describeEvent,
  describeState,
  EARLIER,
  LATER,
  lifecycleOf,
  NOW,
  STATE_EXAMPLES,
} from "./fixtures.ts";

const no = null;

const MATRIX: Readonly<
  Record<LeadStatus, Readonly<Record<LeadEventType, LeadStatus | typeof no>>>
> = {
  new: {
    assign: "assigned",
    returnToPool: no,
    logContact: no,
    scheduleCallBack: no,
    logNoAnswer: no,
    win: no,
    lose: no,
    markDead: "dead",
    reopen: no,
  },
  assigned: {
    assign: "assigned",
    returnToPool: "new",
    logContact: "working",
    scheduleCallBack: "working",
    logNoAnswer: "working",
    win: no,
    lose: no,
    markDead: "dead",
    reopen: no,
  },
  working: {
    assign: "working",
    returnToPool: "new",
    logContact: "working",
    scheduleCallBack: "working",
    logNoAnswer: "working",
    win: "won",
    lose: "lost",
    markDead: "dead",
    reopen: no,
  },
  won: {
    assign: no,
    returnToPool: no,
    logContact: no,
    scheduleCallBack: no,
    logNoAnswer: no,
    win: no,
    lose: no,
    markDead: no,
    reopen: no,
  },
  lost: {
    assign: no,
    returnToPool: no,
    logContact: no,
    scheduleCallBack: no,
    logNoAnswer: no,
    win: no,
    lose: no,
    markDead: no,
    reopen: "new",
  },
  dead: {
    assign: no,
    returnToPool: no,
    logContact: no,
    scheduleCallBack: no,
    logNoAnswer: no,
    win: no,
    lose: no,
    markDead: no,
    reopen: "new",
  },
};

const REFUSALS = [
  "new + markDead(wrongNumber): wrongNumberNeedsAnAttempt",
  "dead(doNotContact) + reopen: doNotContactIsFinal",
  "dead(doNotContact, from the pool) + reopen: doNotContactIsFinal",
];

const CASES = ALL_STATES.flatMap((state) =>
  ALL_EVENTS.map((event) => ({
    name: `${describeState(state)} + ${describeEvent(event)}`,
    state,
    event,
    target: MATRIX[state.status][event.type],
  })),
);

function apply(state: LeadState, event: LeadEvent): LeadLifecycle {
  const result = transition(lifecycleOf(state), event, NOW);
  if (!result.ok) throw new Error(`Expected ${describeEvent(event)} to be accepted`);
  return result.value;
}

describe("transition matrix", () => {
  it.each(CASES.filter((c) => c.target === no))("$name is illegal", ({ state, event }) => {
    expect(transition(lifecycleOf(state), event, NOW)).toEqual({
      ok: false,
      error: { kind: "illegal", from: state.status, event: event.type },
    });
  });

  it.each(CASES.filter((c) => c.target !== no))(
    "$name leads to $target or is refused",
    ({ state, event, target }) => {
      const result = transition(lifecycleOf(state), event, NOW);
      if (result.ok) {
        expect(result.value.state.status).toBe(target);
      } else {
        expect(result.error).toMatchObject({
          kind: "refused",
          from: state.status,
          event: event.type,
        });
      }
    },
  );

  it("refuses exactly the listed pairs", () => {
    const refused = CASES.flatMap(({ name, state, event }) => {
      const result = transition(lifecycleOf(state), event, NOW);
      return !result.ok && result.error.kind === "refused"
        ? [`${name}: ${result.error.reason}`]
        : [];
    });
    expect(refused).toEqual(REFUSALS);
  });
});

describe("working a lead", () => {
  const assigned: LeadState = { status: "assigned", assignee: ana };
  const contacted: LeadState = { status: "working", assignee: ana, stage: { kind: "contacted" } };

  it("moves an assigned lead to working when contact is logged", () => {
    expect(apply(assigned, { type: "logContact" }).state).toEqual(contacted);
  });

  it("records the call-back time", () => {
    expect(apply(assigned, { type: "scheduleCallBack", at: LATER }).state).toEqual({
      status: "working",
      assignee: ana,
      stage: { kind: "callBack", at: LATER },
    });
  });

  it.each([
    ["the present moment", NOW],
    ["a past time", EARLIER],
  ])("refuses a call-back at %s", (_label, at) => {
    expect(transition(lifecycleOf(contacted), { type: "scheduleCallBack", at }, NOW)).toEqual({
      ok: false,
      error: {
        kind: "refused",
        from: "working",
        event: "scheduleCallBack",
        reason: "callBackInPast",
      },
    });
  });

  it.each<[string, LeadState, number]>([
    ["an assigned lead", assigned, 1],
    ["a contacted lead", contacted, 1],
    [
      "a lead waiting for a call-back",
      { status: "working", assignee: ana, stage: { kind: "callBack", at: LATER } },
      1,
    ],
    [
      "a lead with two unanswered calls",
      { status: "working", assignee: ana, stage: { kind: "noAnswer", count: 2 } },
      3,
    ],
  ])("counts unanswered calls for %s", (_label, state, count) => {
    expect(apply(state, { type: "logNoAnswer" }).state).toEqual({
      status: "working",
      assignee: ana,
      stage: { kind: "noAnswer", count },
    });
  });

  it("keeps the status and the stage when a lead is reassigned", () => {
    const waiting: LeadState = {
      status: "working",
      assignee: ana,
      stage: { kind: "callBack", at: LATER },
    };
    expect(apply(waiting, { type: "assign", to: ben }).state).toEqual({
      ...waiting,
      assignee: ben,
    });
  });
});

describe("closing a lead", () => {
  const working: LeadState = { status: "working", assignee: ana, stage: { kind: "contacted" } };

  it("ties a won lead to its account", () => {
    expect(apply(working, { type: "win", accountId }).state).toEqual({
      status: "won",
      assignee: ana,
      accountId,
    });
  });

  it("keeps the reason a lead was lost", () => {
    expect(apply(working, { type: "lose", reason: "choseCompetitor" }).state).toEqual({
      status: "lost",
      assignee: ana,
      reason: "choseCompetitor",
    });
  });

  it("marks a lead dead in the pool without an assignee", () => {
    expect(apply({ status: "new" }, { type: "markDead", reason: "duplicate" }).state).toEqual({
      status: "dead",
      assignee: null,
      reason: "duplicate",
    });
  });

  it.each<[string, LeadState]>([
    ["an assigned lead", { status: "assigned", assignee: ana }],
    ["a lead being worked", working],
  ])("accepts a wrong number for %s and keeps the assignee", (_label, state) => {
    expect(apply(state, { type: "markDead", reason: "wrongNumber" }).state).toEqual({
      status: "dead",
      assignee: ana,
      reason: "wrongNumber",
    });
  });
});

describe("ownership history", () => {
  const assign = (to: typeof ana): LeadEvent => ({ type: "assign", to });
  const reopen: LeadEvent = { type: "reopen", reason: { kind: "inbound", source: "csv" } };

  it("stamps the first assignment and never moves it", () => {
    const pooled: LeadLifecycle = {
      state: { status: "new" },
      firstAssignedAt: null,
      previousOwnerId: null,
    };
    const first = transition(pooled, assign(ana), NOW);
    expect(first).toEqual({
      ok: true,
      value: {
        state: { status: "assigned", assignee: ana },
        firstAssignedAt: NOW,
        previousOwnerId: null,
      },
    });
    if (!first.ok) return;

    const second = transition(first.value, assign(ben), LATER);
    expect(second).toMatchObject({
      ok: true,
      value: { firstAssignedAt: NOW, previousOwnerId: ana.ownerId },
    });
  });

  it("returns an equal lifecycle when a lead is assigned to its current assignee", () => {
    const lead = lifecycleOf({ status: "assigned", assignee: ana });
    expect(transition(lead, assign(ana), LATER)).toEqual({ ok: true, value: lead });
  });

  it("does not count a change of team as a change of owner", () => {
    const moved = apply({ status: "assigned", assignee: ana }, assign(anaOnOtherTeam));
    expect(moved.state).toEqual({ status: "assigned", assignee: anaOnOtherTeam });
    expect(moved.previousOwnerId).toBeNull();
  });

  it("remembers the owner who returned a lead to the pool", () => {
    expect(apply({ status: "assigned", assignee: ana }, { type: "returnToPool" })).toEqual({
      state: { status: "new" },
      firstAssignedAt: EARLIER,
      previousOwnerId: ana.ownerId,
    });
  });

  it("reopens a lost lead into the pool and remembers who closed it", () => {
    expect(apply({ status: "lost", assignee: ana, reason: "badTiming" }, reopen)).toEqual({
      state: { status: "new" },
      firstAssignedAt: EARLIER,
      previousOwnerId: ana.ownerId,
    });
  });

  it("keeps the earlier previous owner when a lead that died in the pool is reopened", () => {
    const lead: LeadLifecycle = {
      state: { status: "dead", assignee: null, reason: "duplicate" },
      firstAssignedAt: EARLIER,
      previousOwnerId: ben.ownerId,
    };
    expect(transition(lead, reopen, NOW)).toEqual({
      ok: true,
      value: { state: { status: "new" }, firstAssignedAt: EARLIER, previousOwnerId: ben.ownerId },
    });
  });

  it("holds its invariants over every sequence of four events from the pool", () => {
    const start: LeadLifecycle = {
      state: { status: "new" },
      firstAssignedAt: null,
      previousOwnerId: null,
    };
    let frontier = [start];
    let visited = 0;
    for (let step = 1; step <= 4; step += 1) {
      const at = new Date(NOW.getTime() + step * 60_000);
      const next: LeadLifecycle[] = [];
      for (const lead of frontier) {
        for (const event of ALL_EVENTS) {
          const result = transition(lead, event, at);
          if (!result.ok) continue;
          const after = result.value;
          visited += 1;

          if (assigneeOf(after.state) !== null) {
            expect(after.firstAssignedAt, "an owned lead has a first assignment").not.toBeNull();
          }
          if (lead.firstAssignedAt !== null) {
            expect(after.firstAssignedAt, "the first assignment never moves").toBe(
              lead.firstAssignedAt,
            );
          }
          next.push(after);
        }
      }
      frontier = next;
    }
    expect(visited).toBeGreaterThan(100);
  });
});

describe("assigneeOf and isOpen", () => {
  it("reads no assignee from a lead in the pool", () => {
    expect(assigneeOf({ status: "new" })).toBeNull();
    expect(assigneeOf({ status: "dead", assignee: null, reason: "duplicate" })).toBeNull();
  });

  it("reads the assignee from every owned state", () => {
    const owned = ALL_STATES.filter(
      (state) => state.status !== "new" && !(state.status === "dead" && state.assignee === null),
    );
    for (const state of owned) {
      expect(assigneeOf(state), describeState(state)).toEqual(ana);
    }
  });

  it.each<[LeadStatus, boolean]>([
    ["new", true],
    ["assigned", true],
    ["working", true],
    ["won", false],
    ["lost", false],
    ["dead", false],
  ])("treats %s as open: %s", (status, open) => {
    for (const state of STATE_EXAMPLES[status]) {
      expect(isOpen(state)).toBe(open);
    }
  });
});
