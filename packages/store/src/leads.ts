import {
  LeadId,
  leadScope,
  type Actor,
  type Email,
  type EmailKey,
  type IntakeSource,
  type Lead,
  type LeadLifecycle,
  type LeadScope,
} from "@relay/domain";
import type { Prisma } from "./generated/client.ts";
import { InvariantError, leadFromRow, lifecycleFromRow, lifecycleToColumns } from "./lead-row.ts";
import type { Db, Tx } from "./tx.ts";

/** A lead as a list shows it: the record plus where it first came from. */
export interface LeadListItem extends Lead {
  /** From the ledger row that created the lead. null for a lead no intake created. */
  readonly origin: { readonly source: IntakeSource; readonly campaign: string | null } | null;
}

/**
 * The SQL reading of a scope, and the only place a scope becomes a query. It stays private:
 * every read exported from this file takes an Actor, so no caller can skip scoping.
 * test/lead-scope.int.test.ts proves it selects exactly the rows `scopeAdmits` accepts.
 */
function leadScopeWhere(scope: LeadScope): Prisma.LeadWhereInput {
  switch (scope.kind) {
    case "all":
      return {};
    case "teamAndPool":
      return { OR: [{ teamId: scope.teamId }, { status: "new" }] };
    case "own":
      return { ownerId: scope.userId };
    case "none":
      return { id: { in: [] } };
  }
}

export async function listLeads(
  db: Db,
  actor: Actor,
  page: { readonly limit: number },
): Promise<readonly LeadListItem[]> {
  const rows = await db.lead.findMany({
    where: leadScopeWhere(leadScope(actor, "read")),
    // Newest first. UUID v7 ascends with time, so the ID breaks ties in the same direction.
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
  return rows.map((row) => ({ ...leadFromRow(row), origin: row.intakeEvents[0] ?? null }));
}

function leadId(value: string): LeadId {
  const id = LeadId.parse(value);
  if (id === null) throw new InvariantError("leads.id is not a canonical UUID");
  return id;
}

/**
 * Intake's view of the lead that holds an email. It is the one read that ignores scope, because
 * identity must see every lead. It returns the ID and the lifecycle, never the record.
 */
export async function findLeadIdentity(
  tx: Tx,
  key: EmailKey,
): Promise<{ readonly id: LeadId; readonly lifecycle: LeadLifecycle } | null> {
  const row = await tx.lead.findUnique({ where: { emailKey: key } });
  return row === null ? null : { id: leadId(row.id), lifecycle: lifecycleFromRow(row) };
}

export interface NewLead {
  readonly email: Email;
  readonly name: string | null;
  readonly phone: string | null;
  readonly lifecycle: LeadLifecycle;
  readonly createdAt: Date;
}

export async function insertLead(tx: Tx, lead: NewLead): Promise<LeadId> {
  const row = await tx.lead.create({
    data: {
      emailKey: lead.email.key,
      email: lead.email.asTyped,
      name: lead.name,
      phone: lead.phone,
      createdAt: lead.createdAt,
      ...lifecycleToColumns(lead.lifecycle),
    },
    select: { id: true },
  });
  return leadId(row.id);
}

export async function updateLifecycle(tx: Tx, id: LeadId, lifecycle: LeadLifecycle): Promise<void> {
  await tx.lead.update({ where: { id }, data: lifecycleToColumns(lifecycle) });
}
