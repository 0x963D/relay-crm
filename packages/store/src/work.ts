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
  type QueueGroup,
  type UserId,
} from "@relay/domain";
import { currentActor } from "./auth.ts";
import { writeAudit } from "./audit.ts";
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
      next.error.kind === "refused" && next.error.reason === "callBackInPast"
        ? "callbackInPast"
        : "invalidTransition",
    );
  return next.value;
}

function callback(before: LeadLifecycle, change: CallbackChange, at: Date): LeadLifecycle {
  if (change.kind === "set")
    return nextState(before, { type: "scheduleCallBack", at: change.at }, at);
  return before.state.status === "working"
    ? nextState(before, { type: "clearCallBack" }, at)
    : before;
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
        const at = new Date();
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
            next = nextState(
              before,
              { type: work.attempt.outcome === "spokeToThem" ? "logContact" : "logNoAnswer" },
              at,
            );
            if (work.attempt.outcome === "spokeToThem") contactedAt ??= at;
            if (work.attempt.callback) next = callback(next, work.attempt.callback, at);
            break;
          case "close": {
            const closing = work.closing;
            switch (closing.kind) {
              case "dead":
                next = nextState(before, { type: "markDead", reason: closing.reason }, at);
                break;
              case "lost":
                next = nextState(before, { type: "lose", reason: closing.reason }, at);
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
          before: JSON.stringify(before),
          after: JSON.stringify(next),
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

function attemptSummary(activities: readonly Activity[]) {
  let noAnswerCount = 0;
  let hasAttempt = false;
  for (const activity of activities) {
    if (activity.kind !== "attempt") continue;
    hasAttempt = true;
    const attempt = activityDetail(activity).attempt;
    if (
      typeof attempt === "object" &&
      attempt !== null &&
      "outcome" in attempt &&
      attempt.outcome === "noAnswer"
    )
      noAnswerCount += 1;
  }
  return { hasAttempt, noAnswerCount };
}

function queueItem(
  row: Lead & { activities: Activity[]; intakeEvents: { campaign: string | null }[] },
) {
  const summary = attemptSummary(row.activities);
  const last = row.activities.find(
    (activity) => activity.kind === "note" || activity.kind === "attempt",
  );
  return {
    ...leadFromRow(row),
    campaign: row.intakeEvents[0]?.campaign ?? null,
    callbackAt: row.callBackAt,
    noAnswerCount: summary.noAnswerCount,
    lastNoteOrOutcome: last ? activityDetail(last) : null,
    hasAttempt: summary.hasAttempt || row.stage === "noAnswer" || row.stage === "contacted",
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
      notYetCalled: [],
    };
    let nextCallbackAt: Date | null = null;
    for (const row of rows) {
      const item = queueItem(row);
      const group = queueGroup(item, input.at, input.timeZone);
      if (group !== null) groups[group].push(item);
      if (
        item.callbackAt !== null &&
        item.callbackAt > input.at &&
        (nextCallbackAt === null || item.callbackAt < nextCallbackAt)
      )
        nextCallbackAt = item.callbackAt;
    }
    return {
      overdueCallbacks: groups.overdueCallbacks.slice(0, input.limit),
      dueToday: groups.dueToday.slice(0, input.limit),
      notYetCalled: groups.notYetCalled.slice(0, input.limit),
      counts: {
        overdueCallbacks: groups.overdueCallbacks.length,
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
    return {
      ...leadFromRow(row),
      contactedAt: row.workHistoryKnown ? row.contactedAt : null,
      lostNote: row.lostNote,
      workHistoryKnown: row.workHistoryKnown,
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
      string | null,
      {
        campaign: string | null;
        received: number;
        unassigned: number;
        knownContacted: number;
        contactUnknown: number;
        won: number;
      }
    >();
    for (const lead of leads) {
      const campaign = lead.intakeEvents[0]?.campaign ?? null;
      const item = campaigns.get(campaign) ?? {
        campaign,
        received: 0,
        unassigned: 0,
        knownContacted: 0,
        contactUnknown: 0,
        won: 0,
      };
      item.received += 1;
      if (lead.status === "new") item.unassigned += 1;
      if (lead.contactedAt !== null) item.knownContacted += 1;
      else if (!lead.workHistoryKnown) item.contactUnknown += 1;
      if (lead.status === "won") item.won += 1;
      campaigns.set(campaign, item);
    }
    return [...campaigns.values()]
      .sort((a, b) => b.received - a.received || (a.campaign ?? "").localeCompare(b.campaign ?? ""))
      .map((item) => ({
        ...item,
        contacted: item.contactUnknown === 0 ? item.knownContacted : null,
        conversion: item.received === 0 ? null : item.won / item.received,
      }));
  });
}
