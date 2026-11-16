import {
  AccountId,
  TeamId,
  scopeAdmits,
  LeadId as LeadIdentifier,
  assigneeOf,
  isOpen,
  queueGroup,
  recordScope,
  transition,
  type Actor,
  type CallbackChange,
  type LeadEvent,
  type LeadId,
  type LeadLifecycle,
  type LeadWork,
  type JsonValue,
  type IntakeSource,
  type QueueGroup,
  type UserId,
} from "@relay/domain";
import { currentActor } from "./auth.ts";
import { snapshot, writeAudit } from "./audit.ts";
import { AccessError } from "./errors.ts";
import { idempotent } from "./idempotency.ts";
import { InvariantError, leadFromRow, lifecycleFromRow } from "./lead-row.ts";
import { scopedLead, updateLifecycle, queueLeadRows, funnelLeadRows } from "./leads.ts";
import { transact, type Db } from "./tx.ts";
import type { Activity, Lead, Prisma } from "./generated/client.ts";

interface WorkReceipt {
  readonly id: LeadId;
  readonly accountId: AccountId | null;
}

function receipt(stored: unknown): WorkReceipt {
  if (
    typeof stored !== "object" ||
    stored === null ||
    !("id" in stored) ||
    !("accountId" in stored)
  )
    throw new InvariantError("Invalid lead work receipt");
  const id = typeof stored.id === "string" ? stored.id : "";
  const accountId =
    stored.accountId === null
      ? null
      : typeof stored.accountId === "string"
        ? AccountId.parse(stored.accountId)
        : null;
  const leadId = parseLeadId(id);
  if (stored.accountId !== null && accountId === null)
    throw new InvariantError("Invalid work account ID");
  return { id: leadId, accountId };
}

function parseLeadId(id: string): LeadId {
  const parsed = LeadIdentifier.parse(id);
  if (parsed === null) throw new InvariantError("Invalid work lead ID");
  return parsed;
}

function nextState(before: LeadLifecycle, event: LeadEvent, at: Date): LeadLifecycle {
  const next = transition(before, event, at);
  if (!next.ok)
    throw new AccessError(
      next.error.kind === "refused"
        ? next.error.reason === "callBackInPast"
          ? "callbackInPast"
          : next.error.reason
        : "invalidTransition",
    );
  return next.value;
}

function callback(before: LeadLifecycle, change: CallbackChange, at: Date): LeadLifecycle {
  if (change.kind === "set")
    return nextState(before, { type: "scheduleCallBack", at: change.at }, at);
  return nextState(before, { type: "clearCallBack" }, at);
}

function callbackJson(change: CallbackChange): Prisma.InputJsonObject & Record<string, JsonValue> {
  return change.kind === "set" ? { kind: "set", at: change.at.toISOString() } : { kind: "clear" };
}
function commandJson(command: LeadWork): Prisma.InputJsonObject & Record<string, JsonValue> {
  switch (command.kind) {
    case "attempt":
      return {
        kind: command.kind,
        attempt: {
          channel: command.attempt.channel,
          outcome: command.attempt.outcome,
          note: command.attempt.note,
          ...(command.attempt.callback ? { callback: callbackJson(command.attempt.callback) } : {}),
        },
      };
    case "callback":
      return { kind: command.kind, change: callbackJson(command.change) };
    case "note":
      return { kind: command.kind, note: command.note };
    case "close":
      return { kind: command.kind, closing: { ...command.closing } };
  }
}

export async function workLead(
  db: Db,
  actor: Actor,
  input: { readonly id: LeadId; readonly key: string; readonly work: LeadWork },
  requestId: string,
  at = new Date(),
) {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const row = await scopedLead(tx, current, input.id, "edit");
    return idempotent(
      tx,
      current,
      {
        key: input.key,
        operation: "leads.work",
        request: { id: input.id, work: commandJson(input.work) },
      },
      receipt,
      async (idempotencyId) => {
        const before = lifecycleFromRow(row);
        const work = input.work;
        if (row.status === "won" && work.kind === "close" && work.closing.kind === "won")
          return { id: row.id, accountId: row.accountId };
        if (!isOpen(before.state)) throw new AccessError("leadClosed");
        let next = before;
        let contactedAt = row.contactedAt;
        let lostNote = row.lostNote;
        switch (work.kind) {
          case "note":
            break;
          case "callback":
            next = callback(before, work.change, at);
            break;
          case "attempt":
            if (work.attempt.callback?.kind === "clear")
              callback(before, work.attempt.callback, at);
            next = nextState(
              before,
              { type: work.attempt.outcome === "spokeToThem" ? "logContact" : "logNoAnswer" },
              at,
            );
            if (work.attempt.outcome === "spokeToThem") contactedAt ??= at;
            if (work.attempt.callback?.kind === "set")
              next = callback(next, work.attempt.callback, at);
            break;
          case "close": {
            const closing = work.closing;
            switch (closing.kind) {
              case "dead": {
                const activities = await tx.activity.findMany({
                  where: { leadId: input.id },
                  orderBy: { sequence: "desc" },
                });
                const hasAttempt = attemptSummary(
                  currentAssignmentActivities(activities),
                ).hasAttempt;
                next = nextState(
                  before,
                  { type: "markDead", reason: closing.reason, hasAttempt },
                  at,
                );
                break;
              }
              case "lost":
                next = nextState(before, { type: "lose", reason: closing.note }, at);
                lostNote = closing.note;
                break;
              case "won": {
                const assignee = assigneeOf(before.state);
                if (before.state.status !== "working" || assignee === null)
                  throw new AccessError("invalidTransition");
                const account = await tx.account.create({
                  data: { ownerId: assignee.ownerId, teamId: assignee.teamId, createdAt: at },
                });
                const accountId = AccountId.parse(account.id);
                if (accountId === null) throw new InvariantError("Invalid new account ID");
                next = nextState(before, { type: "win", accountId }, at);
                break;
              }
            }
            break;
          }
        }
        await updateLifecycle(tx, input.id, next, { contactedAt, lostNote });
        const detail = {
          ...commandJson(work),
          actorId: current.userId,
          requestId,
          before: snapshot(before),
          after: snapshot(next),
        };
        await tx.activity.create({
          data: {
            kind: work.kind === "close" ? "closure" : work.kind,
            leadId: input.id,
            at,
            detail,
          },
        });
        await writeAudit(tx, current, {
          action: "leadWorked",
          subject: { type: "lead", id: input.id },
          before: { lifecycle: before, contactedAt: row.contactedAt, lostNote: row.lostNote },
          after: { lifecycle: next, contactedAt, lostNote },
          cause: { kind: "idempotency", id: idempotencyId, requestId },
          at,
        });
        return {
          id: input.id,
          accountId: next.state.status === "won" ? next.state.accountId : null,
        };
      },
    );
  });
}

function activityDetail(activity: Activity): Record<string, unknown> {
  return typeof activity.detail === "object" &&
    activity.detail !== null &&
    !Array.isArray(activity.detail)
    ? activity.detail
    : {};
}

function activitySummary(activity: Activity, noAnswerCount: number | null = null) {
  const detail = activityDetail(activity);
  if (activity.kind === "note") {
    if (typeof detail.note !== "string") throw new InvariantError("Invalid lead note");
    return { kind: "note", note: detail.note } as const;
  }
  if (activity.kind !== "attempt") return null;
  const attempt = detail.attempt;
  if (
    typeof attempt !== "object" ||
    attempt === null ||
    !("channel" in attempt) ||
    !("outcome" in attempt) ||
    !("note" in attempt) ||
    (attempt.channel !== "call" && attempt.channel !== "whatsApp") ||
    (attempt.outcome !== "noAnswer" && attempt.outcome !== "spokeToThem") ||
    typeof attempt.note !== "string"
  )
    throw new InvariantError("Invalid lead attempt");
  const change = "callback" in attempt ? attempt.callback : null;
  const callbackAt =
    typeof change === "object" &&
    change !== null &&
    "kind" in change &&
    change.kind === "set" &&
    "at" in change &&
    typeof change.at === "string"
      ? new Date(change.at)
      : null;
  if (callbackAt && Number.isNaN(callbackAt.getTime()))
    throw new InvariantError("Invalid attempt callback");
  return {
    callbackAt,
    noAnswerCount,
    kind: "attempt",
    channel: attempt.channel,
    outcome: attempt.outcome,
    note: attempt.note,
  } as const;
}

function attemptSummary(activities: readonly Activity[]) {
  let noAnswerCount = 0;
  let hasAttempt = false;
  for (const activity of activities) {
    const summary = activitySummary(activity);
    if (summary?.kind !== "attempt") continue;
    hasAttempt = true;
    if (summary.outcome === "noAnswer") noAnswerCount += 1;
  }
  return { hasAttempt, noAnswerCount };
}

function currentAssignmentActivities(activities: readonly Activity[]) {
  const assignment = activities.find((activity) => activity.kind === "assignment");
  return activities.filter(
    (activity) => assignment === undefined || activity.sequence > assignment.sequence,
  );
}

function queueItem(
  row: Lead & {
    activities: Activity[];
    intakeEvents: { source: IntakeSource; campaign: string | null }[];
  },
) {
  const assignment = row.activities.find((activity) => activity.kind === "assignment");
  const summary = attemptSummary(currentAssignmentActivities(row.activities));
  const last = row.activities.find(
    (activity) => activity.kind === "note" || activity.kind === "attempt",
  );
  return {
    ...leadFromRow(row, row.intakeEvents[0]?.source),
    assignedAt: assignment?.at ?? row.firstAssignedAt,
    assignmentSequence: assignment?.sequence ?? 0n,
    campaign: row.intakeEvents[0]?.campaign ?? null,
    callbackAt: row.callBackAt,
    noAnswerCount: attemptSummary(row.activities).noAnswerCount,
    lastNoteOrOutcome: last ? activitySummary(last) : null,
    hasAttempt: summary.hasAttempt,
  };
}

export async function workQueue(
  db: Db,
  actor: Actor,
  input: {
    readonly agentId: UserId;
    readonly at: Date;
    readonly timeZone: string;
    readonly limit: number;
    readonly offset?: number;
  },
) {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const scope = recordScope(current, "lead", "read");
    const agent = await tx.user.findUnique({
      where: { id: input.agentId },
      include: { memberships: true },
    });
    const targetAdmitted =
      agent?.role === "agent" &&
      (scopeAdmits(scope, { ownerId: input.agentId, teamId: null }) ||
        agent.memberships.some((member) => {
          const teamId = TeamId.parse(member.teamId);
          if (teamId === null) throw new InvariantError("Invalid agent team ID");
          return scopeAdmits(scope, { ownerId: input.agentId, teamId });
        }));
    if (!targetAdmitted) throw new AccessError("accessDenied");
    const rows = await queueLeadRows(tx, current, input.agentId);
    const groups: Record<QueueGroup, ReturnType<typeof queueItem>[]> = {
      overdueCallbacks: [],
      dueToday: [],
      noCallbackSet: [],
      later: [],
      notYetCalled: [],
    };
    let nextCallbackAt: Date | null = null;
    for (const row of rows) {
      const item = queueItem(row);
      const group = queueGroup(item, input.at, input.timeZone);
      groups[group].push(item);
      if (
        item.callbackAt !== null &&
        item.callbackAt > input.at &&
        (nextCallbackAt === null || item.callbackAt < nextCallbackAt)
      )
        nextCallbackAt = item.callbackAt;
    }
    groups.notYetCalled.sort(
      (a, b) =>
        (b.assignedAt?.getTime() ?? 0) - (a.assignedAt?.getTime() ?? 0) ||
        Number(b.assignmentSequence - a.assignmentSequence) ||
        b.id.localeCompare(a.id),
    );
    return {
      noCallbackSet: groups.noCallbackSet.slice(
        input.offset ?? 0,
        (input.offset ?? 0) + input.limit,
      ),
      later: groups.later.slice(input.offset ?? 0, (input.offset ?? 0) + input.limit),
      overdueCallbacks: groups.overdueCallbacks.slice(
        input.offset ?? 0,
        (input.offset ?? 0) + input.limit,
      ),
      dueToday: groups.dueToday.slice(input.offset ?? 0, (input.offset ?? 0) + input.limit),
      notYetCalled: groups.notYetCalled.slice(input.offset ?? 0, (input.offset ?? 0) + input.limit),
      counts: {
        overdueCallbacks: groups.overdueCallbacks.length,
        noCallbackSet: groups.noCallbackSet.length,
        later: groups.later.length,
        dueToday: groups.dueToday.length,
        notYetCalled: groups.notYetCalled.length,
      },
      at: input.at,
      timeZone: input.timeZone,
      nextCallbackAt,
    };
  });
}

export async function leadDetail(db: Db, actor: Actor, id: LeadId) {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const row = await scopedLead(tx, current, id, "read");
    const origin = await tx.intakeEvent.findFirst({
      where: { leadId: id, outcome: "leadCreated" },
      orderBy: { id: "asc" },
    });
    const activities = await tx.activity.findMany({
      where: { leadId: id },
      orderBy: { sequence: "desc" },
    });
    const assignment = activities.find((activity) => activity.kind === "assignment");
    const actorId = assignment ? activityDetail(assignment).actorId : null;
    const assignedBy =
      typeof actorId === "string"
        ? await tx.user.findUnique({ where: { id: actorId }, select: { id: true, name: true } })
        : null;
    const heldBy = row.ownerId
      ? await tx.user.findUnique({ where: { id: row.ownerId }, select: { id: true, name: true } })
      : null;
    const actorIds = activities.flatMap((activity) => {
      const id = activityDetail(activity).actorId;
      return typeof id === "string" ? [id] : [];
    });
    const users = await tx.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, name: true },
    });
    let count = 0;
    const summaries = new Map(
      activities.toReversed().map((activity) => {
        const summary = activitySummary(activity);
        if (summary?.kind === "attempt" && summary.outcome === "noAnswer") count += 1;
        return [activity.id, activitySummary(activity, count)];
      }),
    );
    return {
      ...leadFromRow(row, origin?.source),
      contactedAt: row.contactedAt,
      lostNote: row.lostNote,
      noAnswerCount: attemptSummary(activities).noAnswerCount,
      custody: {
        receivedFrom: origin ? { source: origin.source, at: origin.receivedAt } : null,
        assignedBy: assignedBy ? { ...assignedBy, at: assignment?.at ?? null } : null,
        heldBy: heldBy ? { ...heldBy, since: assignment?.at ?? row.firstAssignedAt } : null,
      },
      attribution: origin
        ? { campaign: origin.campaign, adSet: origin.adSet, ad: origin.ad, form: origin.form }
        : null,
      timeline: activities.map((activity) => ({
        ...activity,
        summary: summaries.get(activity.id) ?? null,
        actor: users.find((user) => user.id === activityDetail(activity).actorId) ?? null,
      })),
    };
  });
}

export async function campaignFunnel(db: Db, actor: Actor) {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    if (recordScope(current, "lead", "read").kind !== "all") throw new AccessError("accessDenied");
    const leads = await funnelLeadRows(tx, current);
    const campaigns = new Map<
      string,
      {
        source: IntakeSource | null;
        campaign: string | null;
        received: number;
        unassigned: number;
        contacted: number;
        won: number;
      }
    >();
    for (const lead of leads) {
      const source = lead.intakeEvents[0]?.source ?? null;
      const campaign = lead.intakeEvents[0]?.campaign ?? null;
      const key = JSON.stringify([source, campaign]);
      const item = campaigns.get(key) ?? {
        source,
        campaign,
        received: 0,
        unassigned: 0,
        contacted: 0,
        won: 0,
      };
      item.received += 1;
      if (lead.status === "new") item.unassigned += 1;
      if (lead.contactedAt !== null) item.contacted += 1;
      if (lead.status === "won") item.won += 1;
      campaigns.set(key, item);
    }
    const rows = [...campaigns.values()]
      .sort((a, b) => b.received - a.received || (a.campaign ?? "").localeCompare(b.campaign ?? ""))
      .map((item) => ({
        ...item,
        conversion: item.received === 0 ? null : item.won / item.received,
      }));
    return {
      rows,
      campaignCount: rows.filter((row) => row.source === "metaLeadAds" && row.campaign !== null)
        .length,
      otherSourceCount: new Set(
        rows
          .filter((row) => row.source !== "metaLeadAds" || row.campaign === null)
          .map((row) => row.source),
      ).size,
    };
  });
}
