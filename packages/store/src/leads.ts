import {
  LeadId,
  scopeAdmits,
  recordScope,
  type Actor,
  type EmailAddress,
  type IntakeSource,
  type Lead,
  type LeadLifecycle,
  type SystemPrincipal,
  type RecordAccess,
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
    return rows.map((row) => ({ ...leadFromRow(row), origin: row.intakeEvents[0] ?? null }));
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

export async function updateLifecycle(tx: Tx, id: LeadId, lifecycle: LeadLifecycle): Promise<void> {
  await tx.lead.update({ where: { id }, data: { ...lifecycleToColumns(lifecycle) } });
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
