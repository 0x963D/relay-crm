import {
  LeadId,
  scopeAdmits,
  recordScope,
  type Actor,
  UserId,
  type EmailAddress,
  type IntakeSource,
  type Lead,
  type LeadLifecycle,
  type SystemPrincipal,
  type RecordAccess,
  TeamId,
} from "@relay/domain";
import { currentActor } from "./auth.ts";
import { scopeWhere } from "./scope.ts";
import { InvariantError, leadFromRow, lifecycleFromRow, lifecycleToColumns } from "./lead-row.ts";
import { transact, type Db, type Tx } from "./tx.ts";
import { AccessError } from "./errors.ts";

export interface LeadListItem extends Lead {
  /** From the ledger row that created the lead. null for a lead no intake created. */
  readonly origin: { readonly source: IntakeSource; readonly campaign: string | null } | null;
}

export async function leadPool(db: Db, actor: Actor, page: { limit: number; offset: number }) {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const scope = recordScope(current, "lead", "assign");
    if (scope.kind === "none") throw new AccessError("accessDenied");
    const where = { status: "new" as const, AND: scopeWhere(scope) };
    const rows = await tx.lead.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: page.limit,
      skip: page.offset,
      include: {
        previousOwner: { select: { id: true, name: true } },
        intakeEvents: {
          where: { outcome: "leadCreated" },
          select: { source: true, campaign: true },
          take: 1,
        },
      },
    });
    const summary = await tx.lead.aggregate({ where, _count: true, _min: { createdAt: true } });
    return {
      total: summary._count,
      oldestAt: summary._min.createdAt,
      rows: rows.map((row) => ({
        ...leadFromRow(row, row.intakeEvents[0]?.source),
        origin: row.intakeEvents[0] ?? null,
        previousOwner: row.previousOwner,
      })),
    };
  });
}

export async function queueAgents(db: Db, actor: Actor, offset: number) {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const scope = recordScope(current, "lead", "read");
    if (scope.kind === "none") throw new AccessError("accessDenied");
    const members = await tx.membership.findMany({
      where: {
        user: { role: "agent" },
        team: { kind: "sales" },
        ...(scope.kind === "own" ? { userId: scope.userId } : {}),
        ...(scope.kind === "team" || scope.kind === "teamAndPool" ? { teamId: scope.teamId } : {}),
      },
      orderBy: [{ user: { name: "asc" } }, { userId: "asc" }, { teamId: "asc" }],
      take: 100,
      skip: offset,
      include: { user: { select: { name: true } }, team: { select: { name: true } } },
    });
    const admitted = members.filter((member) => {
      const ownerId = UserId.parse(member.userId);
      const teamId = TeamId.parse(member.teamId);
      return ownerId !== null && teamId !== null && scopeAdmits(scope, { ownerId, teamId });
    });
    const counts = await tx.lead.groupBy({
      by: ["ownerId"],
      where: {
        ownerId: { in: admitted.map((member) => member.userId) },
        status: { in: ["assigned", "working"] },
        AND: scopeWhere(scope),
      },
      _count: { _all: true },
    });
    const openCounts = new Map(counts.map((row) => [row.ownerId, row._count._all]));
    return admitted.map((member) => {
      const ownerId = UserId.parse(member.userId);
      const teamId = TeamId.parse(member.teamId);
      if (!ownerId || !teamId) throw new InvariantError("Invalid agent membership");
      return {
        ownerId,
        teamId,
        name: member.user.name,
        team: member.team.name,
        openCount: openCounts.get(ownerId) ?? 0,
      };
    });
  });
}

export async function listLeads(
  db: Db,
  actor: Actor,
  page: { readonly limit: number },
): Promise<readonly LeadListItem[]> {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const rows = await tx.lead.findMany({
      where: scopeWhere(recordScope(current, "lead", "read")),
      // UUID v7 ascends with time, so the ID breaks ties in the same direction.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: page.limit,
      include: {
        intakeEvents: {
          where: { outcome: "leadCreated" },
          select: { source: true, campaign: true },
          take: 1,
        },
      },
    });
    return rows.map((row) => ({
      ...leadFromRow(row, row.intakeEvents[0]?.source),
      origin: row.intakeEvents[0] ?? null,
    }));
  });
}

function leadId(value: string): LeadId {
  const id = LeadId.parse(value);
  if (id === null) throw new InvariantError("leads.id is not a canonical UUID");
  return id;
}

export async function findLeadIdentity(
  tx: Tx,
  principal: SystemPrincipal,
  email: EmailAddress,
): Promise<{ readonly id: LeadId; readonly lifecycle: LeadLifecycle } | null> {
  const row = await tx.lead.findFirst({
    where: { email, AND: scopeWhere(recordScope(principal, "lead", "identity")) },
  });
  return row === null ? null : { id: leadId(row.id), lifecycle: lifecycleFromRow(row) };
}

export interface NewLead {
  readonly email: EmailAddress;
  readonly name: string | null;
  readonly phone: string | null;
  readonly lifecycle: LeadLifecycle;
  readonly createdAt: Date;
}

export async function insertLead(tx: Tx, lead: NewLead): Promise<LeadId> {
  const row = await tx.lead.create({
    data: {
      email: lead.email,
      name: lead.name,
      phone: lead.phone,
      createdAt: lead.createdAt,
      ...lifecycleToColumns(lead.lifecycle),
    },
    select: { id: true },
  });
  return leadId(row.id);
}

export async function updateLifecycle(
  tx: Tx,
  id: LeadId,
  lifecycle: LeadLifecycle,
  fields?: { readonly contactedAt: Date | null; readonly lostNote: string | null },
): Promise<void> {
  await tx.lead.update({
    where: { id },
    data: {
      ...lifecycleToColumns(lifecycle),
      ...fields,
      ...(lifecycle.state.status === "lost" ? {} : { lostNote: null }),
    },
  });
}

export async function scopedLead(
  tx: Tx,
  actor: Actor | SystemPrincipal,
  id: LeadId,
  access: RecordAccess,
) {
  const row = await tx.lead.findUnique({ where: { id } });
  if (!row || !scopeAdmits(recordScope(actor, "lead", access), lifecycleFromRow(row).state)) {
    throw new AccessError("accessDenied");
  }
  return row;
}
export async function editLeadFields(
  tx: Tx,
  id: LeadId,
  fields: { readonly name: string | null; readonly phone: string | null },
): Promise<Lead> {
  return leadFromRow(await tx.lead.update({ where: { id }, data: { ...fields } }));
}

export async function queueLeadRows(tx: Tx, actor: Actor, agentId: UserId) {
  return tx.lead.findMany({
    where: {
      AND: [
        scopeWhere(recordScope(actor, "lead", "read")),
        { ownerId: agentId, status: { in: ["assigned", "working"] } },
      ],
    },
    orderBy: [{ callBackAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }],
    include: {
      activities: { orderBy: { sequence: "desc" } },
      intakeEvents: {
        where: { outcome: "leadCreated" },
        orderBy: { id: "asc" },
        select: { source: true, campaign: true },
        take: 1,
      },
    },
  });
}

export async function funnelLeadRows(tx: Tx, actor: Actor) {
  if (recordScope(actor, "lead", "read").kind !== "all") throw new AccessError("accessDenied");
  return tx.lead.findMany({
    include: {
      intakeEvents: { where: { outcome: "leadCreated" }, orderBy: { id: "asc" }, take: 1 },
    },
  });
}
