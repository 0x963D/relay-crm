import type { EmailAddress } from "./email.ts";
import type { AccountId, LeadId, TeamId, UserId } from "./ids.ts";
import { err, ok, type Result } from "./result.ts";

export const INTAKE_SOURCES = ["metaLeadAds", "webForm", "csv", "manual"] as const;
export type IntakeSource = (typeof INTAKE_SOURCES)[number];

export const LOST_REASONS = [
  "notInterested",
  "noBudget",
  "choseCompetitor",
  "badTiming",
  "other",
] as const;
export type LostReason = (typeof LOST_REASONS)[number];

export const DEAD_REASONS = ["duplicate", "wrongNumber", "doNotContact"] as const;
export type DeadReason = (typeof DEAD_REASONS)[number];

export interface Assignment {
  readonly ownerId: UserId;
  readonly teamId: TeamId;
}

export type WorkStage =
  | { readonly kind: "contacted" }
  | { readonly kind: "callBack"; readonly at: Date }
  | { readonly kind: "noAnswer"; readonly count: number };

export type LeadState =
  | { readonly status: "new" }
  | { readonly status: "assigned"; readonly assignee: Assignment }
  | { readonly status: "working"; readonly assignee: Assignment; readonly stage: WorkStage }
  | { readonly status: "won"; readonly assignee: Assignment; readonly accountId: AccountId }
  | { readonly status: "lost"; readonly assignee: Assignment; readonly reason: LostReason }
  | { readonly status: "dead"; readonly assignee: Assignment | null; readonly reason: DeadReason };

export type LeadStatus = LeadState["status"];
export type StateOf<S extends LeadStatus> = Extract<LeadState, { status: S }>;

export interface LeadLifecycle {
  readonly state: LeadState;
  readonly firstAssignedAt: Date | null;
  readonly previousOwnerId: UserId | null;
}

export interface Lead {
  readonly id: LeadId;
  readonly email: EmailAddress;
  readonly name: string | null;
  readonly phone: string | null;
  readonly lifecycle: LeadLifecycle;
  readonly createdAt: Date;
}

export interface InboundReopen {
  readonly kind: "inbound";
  readonly source: IntakeSource;
}
export type ReopenReason = InboundReopen;

export type LeadEvent =
  | { readonly type: "assign"; readonly to: Assignment }
  | { readonly type: "returnToPool" }
  | { readonly type: "logContact" }
  | { readonly type: "scheduleCallBack"; readonly at: Date }
  | { readonly type: "logNoAnswer" }
  | { readonly type: "win"; readonly accountId: AccountId }
  | { readonly type: "lose"; readonly reason: LostReason }
  | { readonly type: "markDead"; readonly reason: DeadReason }
  | { readonly type: "reopen"; readonly reason: ReopenReason };

export type LeadEventType = LeadEvent["type"];
export type EventOf<E extends LeadEventType> = Extract<LeadEvent, { type: E }>;

export type TransitionRefusal =
  "wrongNumberNeedsAnAttempt" | "doNotContactIsFinal" | "callBackInPast";

/**
 * `illegal`: the status never takes this event. `refused`: the status takes it, but the details of
 * this lead or this event rule it out.
 */
export type TransitionError =
  | { readonly kind: "illegal"; readonly from: LeadStatus; readonly event: LeadEventType }
  | {
      readonly kind: "refused";
      readonly from: LeadStatus;
      readonly event: LeadEventType;
      readonly reason: TransitionRefusal;
    };

const illegal = null;

type Rule<S extends LeadStatus, E extends LeadEventType> =
  | ((from: StateOf<S>, event: EventOf<E>, at: Date) => Result<LeadState, TransitionRefusal>)
  | typeof illegal;

type Row<S extends LeadStatus> = { readonly [E in LeadEventType]: Rule<S, E> };
type Rules = { readonly [S in LeadStatus]: Row<S> };

function toPool(): Result<LeadState, never> {
  return ok({ status: "new" });
}

function work(assignee: Assignment, stage: WorkStage): Result<LeadState, never> {
  return ok({ status: "working", assignee, stage });
}

function callBack(
  assignee: Assignment,
  callAt: Date,
  now: Date,
): Result<LeadState, TransitionRefusal> {
  if (callAt.getTime() <= now.getTime()) return err("callBackInPast");
  return work(assignee, { kind: "callBack", at: callAt });
}

const RULES: Rules = {
  new: {
    assign: (_from, event) => ok({ status: "assigned", assignee: event.to }),
    returnToPool: illegal,
    logContact: illegal,
    scheduleCallBack: illegal,
    logNoAnswer: illegal,
    win: illegal,
    lose: illegal,
    markDead: (_from, event) =>
      event.reason === "wrongNumber"
        ? err("wrongNumberNeedsAnAttempt")
        : ok({ status: "dead", assignee: null, reason: event.reason }),
    reopen: illegal,
  },
  assigned: {
    assign: (from, event) => ok({ ...from, assignee: event.to }),
    returnToPool: toPool,
    logContact: (from) => work(from.assignee, { kind: "contacted" }),
    scheduleCallBack: (from, event, at) => callBack(from.assignee, event.at, at),
    logNoAnswer: (from) => work(from.assignee, { kind: "noAnswer", count: 1 }),
    win: illegal,
    lose: illegal,
    markDead: (from, event) =>
      ok({ status: "dead", assignee: from.assignee, reason: event.reason }),
    reopen: illegal,
  },
  working: {
    assign: (from, event) => ok({ ...from, assignee: event.to }),
    returnToPool: toPool,
    logContact: (from) => work(from.assignee, { kind: "contacted" }),
    scheduleCallBack: (from, event, at) => callBack(from.assignee, event.at, at),
    logNoAnswer: (from) =>
      work(from.assignee, {
        kind: "noAnswer",
        count: from.stage.kind === "noAnswer" ? from.stage.count + 1 : 1,
      }),
    win: (from, event) =>
      ok({ status: "won", assignee: from.assignee, accountId: event.accountId }),
    lose: (from, event) => ok({ status: "lost", assignee: from.assignee, reason: event.reason }),
    markDead: (from, event) =>
      ok({ status: "dead", assignee: from.assignee, reason: event.reason }),
    reopen: illegal,
  },
  won: {
    assign: illegal,
    returnToPool: illegal,
    logContact: illegal,
    scheduleCallBack: illegal,
    logNoAnswer: illegal,
    win: illegal,
    lose: illegal,
    markDead: illegal,
    reopen: illegal,
  },
  lost: {
    assign: illegal,
    returnToPool: illegal,
    logContact: illegal,
    scheduleCallBack: illegal,
    logNoAnswer: illegal,
    win: illegal,
    lose: illegal,
    markDead: illegal,
    reopen: toPool,
  },
  dead: {
    assign: illegal,
    returnToPool: illegal,
    logContact: illegal,
    scheduleCallBack: illegal,
    logNoAnswer: illegal,
    win: illegal,
    lose: illegal,
    markDead: illegal,
    reopen: (from) => (from.reason === "doNotContact" ? err("doNotContactIsFinal") : toPool()),
  },
};

function hasStatus<S extends LeadStatus>(state: LeadState, status: S): state is StateOf<S> {
  return state.status === status;
}

function hasType<E extends LeadEventType>(event: LeadEvent, type: E): event is EventOf<E> {
  return event.type === type;
}

/**
 * Looks up one cell and calls it. A cell's parameter types depend on its row and column, so the
 * compiler needs two things a plain `RULES[a][b](state, event)` cannot give it: the row and the
 * cell read as separate typed steps, and the guards that tie the state and the event to them.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- S and E link the lookups to the guards inside the body, which the rule does not inspect.
function applyRule<S extends LeadStatus, E extends LeadEventType>(
  status: S,
  type: E,
  state: LeadState,
  event: LeadEvent,
  at: Date,
): Result<LeadState, TransitionError> {
  const row: Row<S> = RULES[status];
  const rule: Rule<S, E> = row[type];
  if (rule === illegal || !hasStatus(state, status) || !hasType(event, type)) {
    return err({ kind: "illegal", from: state.status, event: event.type });
  }
  const next = rule(state, event, at);
  if (next.ok) return next;
  return err({ kind: "refused", from: state.status, event: event.type, reason: next.error });
}

/**
 * Applies one event to a lead. Ownership history is derived here, once, for every event, so no
 * rule can forget it. Assigning a lead to its current assignee returns an equal lifecycle.
 */
export function transition(
  lead: LeadLifecycle,
  event: LeadEvent,
  at: Date,
): Result<LeadLifecycle, TransitionError> {
  const next = applyRule(lead.state.status, event.type, lead.state, event, at);
  if (!next.ok) return next;

  const before = assigneeOf(lead.state);
  const after = assigneeOf(next.value);
  const ownerLeft = before !== null && before.ownerId !== after?.ownerId;
  return ok({
    state: next.value,
    firstAssignedAt: lead.firstAssignedAt ?? (after === null ? null : at),
    previousOwnerId: ownerLeft ? before.ownerId : lead.previousOwnerId,
  });
}

export function assigneeOf(state: LeadState): Assignment | null {
  switch (state.status) {
    case "new":
      return null;
    case "assigned":
    case "working":
    case "won":
    case "lost":
    case "dead":
      return state.assignee;
  }
}

export function isOpen(state: LeadState): boolean {
  switch (state.status) {
    case "new":
    case "assigned":
    case "working":
      return true;
    case "won":
    case "lost":
    case "dead":
      return false;
  }
}
