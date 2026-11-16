import {
  AccountId,
  isEmailAddress,
  LeadId,
  TeamId,
  UserId,
  type Assignment,
  type AuditAction,
  type AuditSubject,
  type SystemActor,
  type DeadReason,
  type EmailAddress,
  type IntakeOutcome,
  type IntakeSource,
  type Lead,
  type LeadLifecycle,
  type LeadState,
  type LeadStatus,
  type LostReason,
  type Role,
  type TeamKind,
  type WorkStage,
} from "@relay/domain";
import type { $Enums, Lead as LeadRow } from "./generated/client.ts";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

export type EnumParity = [
  Assert<Same<$Enums.AuditAction, AuditAction>>,
  Assert<Same<$Enums.AuditSubjectType, AuditSubject["type"]>>,
  Assert<Same<$Enums.SystemActor, SystemActor>>,
  Assert<Same<$Enums.LeadStatus, LeadStatus>>,
  Assert<Same<$Enums.WorkStage, WorkStage["kind"]>>,
  Assert<Same<$Enums.LostReason, LostReason>>,
  Assert<Same<$Enums.DeadReason, DeadReason>>,
  Assert<Same<$Enums.IntakeSource, IntakeSource>>,
  Assert<Same<$Enums.IntakeOutcome, IntakeOutcome["kind"]>>,
  Assert<Same<$Enums.Role, Role>>,
  Assert<Same<$Enums.TeamKind, TeamKind>>,
];

export class InvariantError extends Error {
  override readonly name = "InvariantError";
}

export type StateColumns = Pick<
  LeadRow,
  | "status"
  | "ownerId"
  | "teamId"
  | "stage"
  | "callBackAt"
  | "noAnswerCount"
  | "lostReason"
  | "deadReason"
  | "accountId"
>;

export type LifecycleColumns = StateColumns & Pick<LeadRow, "firstAssignedAt" | "previousOwnerId">;

const BLANK = {
  ownerId: null,
  teamId: null,
  stage: null,
  callBackAt: null,
  noAnswerCount: null,
  lostReason: null,
  deadReason: null,
  accountId: null,
} satisfies Omit<StateColumns, "status">;

function ownerColumns(assignee: Assignment): Pick<StateColumns, "ownerId" | "teamId"> {
  return { ownerId: assignee.ownerId, teamId: assignee.teamId };
}

function stageColumns(
  stage: WorkStage,
): Pick<StateColumns, "stage" | "callBackAt" | "noAnswerCount"> {
  switch (stage.kind) {
    case "contacted":
      return { stage: "contacted", callBackAt: null, noAnswerCount: null };
    case "callBack":
      return { stage: "callBack", callBackAt: stage.at, noAnswerCount: null };
    case "noAnswer":
      return { stage: "noAnswer", callBackAt: null, noAnswerCount: stage.count };
  }
}

export function stateToColumns(state: LeadState): StateColumns {
  switch (state.status) {
    case "new":
      return { ...BLANK, status: "new" };
    case "assigned":
      return { ...BLANK, status: "assigned", ...ownerColumns(state.assignee) };
    case "working":
      return {
        ...BLANK,
        status: "working",
        ...ownerColumns(state.assignee),
        ...stageColumns(state.stage),
      };
    case "won":
      return {
        ...BLANK,
        status: "won",
        ...ownerColumns(state.assignee),
        accountId: state.accountId,
      };
    case "lost":
      return {
        ...BLANK,
        status: "lost",
        ...ownerColumns(state.assignee),
        lostReason: state.reason,
      };
    case "dead":
      return {
        ...BLANK,
        status: "dead",
        ...(state.assignee === null ? {} : ownerColumns(state.assignee)),
        deadReason: state.reason,
      };
  }
}

export function lifecycleToColumns(lifecycle: LeadLifecycle): LifecycleColumns {
  return {
    ...stateToColumns(lifecycle.state),
    firstAssignedAt: lifecycle.firstAssignedAt,
    previousOwnerId: lifecycle.previousOwnerId,
  };
}

function present<T>(value: T | null, column: string): T {
  if (value === null) throw new InvariantError(`leads.${column} is null in a status that needs it`);
  return value;
}

function branded<T extends string>(
  guard: { parse(value: string): T | null },
  value: string,
  column: string,
): T {
  const parsed = guard.parse(value);
  if (parsed === null) throw new InvariantError(`leads.${column} is not a canonical UUID`);
  return parsed;
}

function emailAddress(value: string): EmailAddress {
  if (!isEmailAddress(value)) throw new InvariantError("leads.email is not a canonical address");
  return value;
}

function assigneeFromRow(row: Pick<StateColumns, "ownerId" | "teamId">): Assignment | null {
  if (row.ownerId === null && row.teamId === null) return null;
  return {
    ownerId: branded(UserId, present(row.ownerId, "owner_id"), "owner_id"),
    teamId: branded(TeamId, present(row.teamId, "team_id"), "team_id"),
  };
}

function stageFromRow(row: StateColumns): WorkStage {
  switch (present(row.stage, "stage")) {
    case "contacted":
      return { kind: "contacted" };
    case "callBack":
      return { kind: "callBack", at: present(row.callBackAt, "call_back_at") };
    case "noAnswer":
      return { kind: "noAnswer", count: present(row.noAnswerCount, "no_answer_count") };
  }
}

function stateFromRow(row: StateColumns): LeadState {
  const assignee = assigneeFromRow(row);
  switch (row.status) {
    case "new":
      return { status: "new" };
    case "assigned":
      return { status: "assigned", assignee: present(assignee, "owner_id") };
    case "working":
      return {
        status: "working",
        assignee: present(assignee, "owner_id"),
        stage: stageFromRow(row),
      };
    case "won":
      return {
        status: "won",
        assignee: present(assignee, "owner_id"),
        accountId: branded(AccountId, present(row.accountId, "account_id"), "account_id"),
      };
    case "lost":
      return {
        status: "lost",
        assignee: present(assignee, "owner_id"),
        reason: present(row.lostReason, "lost_reason"),
      };
    case "dead":
      return { status: "dead", assignee, reason: present(row.deadReason, "dead_reason") };
  }
}

export function lifecycleFromRow(row: LifecycleColumns): LeadLifecycle {
  return {
    state: stateFromRow(row),
    firstAssignedAt: row.firstAssignedAt,
    previousOwnerId:
      row.previousOwnerId === null
        ? null
        : branded(UserId, row.previousOwnerId, "previous_owner_id"),
  };
}

export function leadFromRow(row: LeadRow): Lead {
  return {
    id: branded(LeadId, row.id, "id"),
    email: emailAddress(row.email),
    name: row.name,
    phone: row.phone,
    lifecycle: lifecycleFromRow(row),
    createdAt: row.createdAt,
    contactedAt: row.contactedAt,
    lostNote: row.lostNote,
  };
}
