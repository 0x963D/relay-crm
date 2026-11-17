import { idempotent, requestHash } from "./idempotency.ts";
import { snapshot, writeAudit } from "./audit.ts";
import {
  LeadId,
  UserId,
  TeamId,
  planDistribution,
  recordScope,
  isAssignableAgent,
  scopeAdmits,
  scopeHasRecords,
  transition,
  type Actor,
  type AuditCause,
  type Assignment,
  type DistributionRequest,
  type DistributionPreview,
  type DistributionResult,
  type DistributionItem,
  type DistributionLead,
  type Lead,
} from "@relay/domain";
import { currentActor } from "./auth.ts";
import { AccessError } from "./errors.ts";
import { InvariantError, leadFromRow, lifecycleFromRow } from "./lead-row.ts";
import { scopedLead, updateLifecycle, editLeadFields, openLeadCounts } from "./leads.ts";
import { transact, type Db, type Tx } from "./tx.ts";

async function agentFor(tx: Tx, actor: Actor, to: Assignment): Promise<void> {
  if (!scopeAdmits(recordScope(actor, "lead", "assign"), to)) throw new AccessError("accessDenied");
  const member = await tx.membership.findUnique({
    where: { userId_teamId: { userId: to.ownerId, teamId: to.teamId } },
    include: { user: true, team: true },
  });
  if (!member && recordScope(actor, "lead", "assign").kind !== "all")
    throw new AccessError("accessDenied");
  if (!isAssignableAgent(member ? { role: member.user.role, teamKind: member.team.kind } : null))
    throw new AccessError("invalidAgent");
}

export async function editLead(
  db: Db,
  actor: Actor,
  id: LeadId,
  fields: { readonly name: string | null; readonly phone: string | null },
  requestId: string,
  at = new Date(),
): Promise<Lead> {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const row = await scopedLead(tx, current, id, "edit");
    if (row.name === fields.name && row.phone === fields.phone) return leadFromRow(row);
    const before = { name: row.name, phone: row.phone };
    const lead = await editLeadFields(tx, id, fields);
    await writeAudit(tx, current, {
      action: "leadEdited",
      subject: { type: "lead", id },
      before,
      after: fields,
      cause: { kind: "request", id: requestId },
      at,
    });
    await tx.activity.create({
      data: {
        kind: "edit",
        leadId: id,
        detail: { actorId: current.userId, requestId, before, after: fields },
        at,
      },
    });
    return lead;
  });
}

async function applyAssignment(
  tx: Tx,
  actor: Actor,
  item: DistributionItem,
  mode: "pool" | "owned",
  cause: AuditCause,
  at = new Date(),
): Promise<boolean> {
  const row = await scopedLead(tx, actor, item.leadId, "assign");
  if ((mode === "pool" && row.status !== "new") || (mode === "owned" && row.status === "new"))
    throw new AccessError("conflict");
  await agentFor(tx, actor, item.to);
  const before = lifecycleFromRow(row);
  const next = transition(before, { type: "assign", to: item.to }, at);
  if (!next.ok) throw new AccessError("conflict");
  if (JSON.stringify(before) === JSON.stringify(next.value)) return false;
  await updateLifecycle(tx, item.leadId, next.value);
  const detail = {
    to: { ...item.to },
    before: snapshot(before),
    after: snapshot(next.value),
  };
  await tx.activity.create({
    data: {
      kind: "assignment",
      leadId: item.leadId,
      detail: {
        actorId: actor.userId,
        requestId: cause.kind === "idempotency" ? cause.requestId : cause.id,
        ...detail,
      },
      at,
    },
  });
  await writeAudit(tx, actor, {
    action: "leadAssigned",
    subject: { type: "lead", id: item.leadId },
    before: { lifecycle: before },
    after: { lifecycle: next.value },
    cause,
    at,
  });
  return true;
}

export async function assignPool(
  db: Db,
  actor: Actor,
  leadIds: readonly LeadId[],
  to: Assignment,
  requestId: string,
  at = new Date(),
): Promise<DistributionResult> {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const items = [...new Set(leadIds)].sort().map((leadId) => ({ leadId, to }));
    if (items.length === 0) throw new AccessError("conflict");
    const cause = { kind: "request", id: requestId } as const;
    for (const item of items) await applyAssignment(tx, current, item, "pool", cause, at);
    return { items, changed: true };
  });
}
export async function reassignLead(
  db: Db,
  actor: Actor,
  leadId: LeadId,
  to: Assignment,
  requestId: string,
): Promise<DistributionResult> {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const item = { leadId, to };
    const changed = await applyAssignment(tx, current, item, "owned", {
      kind: "request",
      id: requestId,
    });
    return { items: changed ? [item] : [], changed };
  });
}

export async function previewDistribution(
  db: Db,
  actor: Actor,
  request: DistributionRequest,
): Promise<DistributionPreview> {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    if (!scopeHasRecords(recordScope(current, "lead", "assign")))
      throw new AccessError("accessDenied");
    const waiting: { lead: DistributionLead; since: Date }[] = [];
    for (const id of [...new Set(request.leadIds)].sort()) {
      const row = await scopedLead(tx, current, id, "assign");
      if (row.status !== "new") throw new AccessError("conflict");
      waiting.push({
        lead: { id, version: row.version, lifecycle: lifecycleFromRow(row) },
        since: row.createdAt,
      });
    }
    const leads = waiting
      .sort((a, b) => a.since.getTime() - b.since.getTime() || a.lead.id.localeCompare(b.lead.id))
      .map((entry) => entry.lead);
    const agents = [...request.agents].sort(
      (a, b) => a.ownerId.localeCompare(b.ownerId) || a.teamId.localeCompare(b.teamId),
    );
    if (
      !leads.length ||
      !agents.length ||
      new Set(agents.map((a) => a.ownerId)).size !== agents.length
    )
      throw new AccessError("invalidAgent");
    for (const to of agents) await agentFor(tx, current, to);
    const counts = await openLeadCounts(
      tx,
      agents.map((agent) => agent.ownerId),
      { kind: "all" },
    );
    const queueSizes = new Map(
      agents.map((agent) => [agent.ownerId, counts.get(agent.ownerId) ?? 0]),
    );
    const planned = planDistribution(leads, agents, request.excludePreviousOwner, queueSizes);
    if (!planned.ok) throw new AccessError(planned.error);
    const snapshot = leads.map((lead) => ({ id: lead.id, version: lead.version }));
    const storedRequest = {
      agents: agents.map((a) => ({ ...a })),
      items: planned.value.map((item) => ({ leadId: item.leadId, to: { ...item.to } })),
      excludePreviousOwner: request.excludePreviousOwner,
    };
    const fingerprint = requestHash({ actorId: current.userId, snapshot, request: storedRequest });
    const preview = await tx.distributionPreview.create({
      data: { actorId: current.userId, fingerprint, request: storedRequest, snapshot },
    });
    return { id: preview.id, fingerprint, items: planned.value };
  });
}

function storedItems(value: unknown): readonly DistributionItem[] {
  if (!Array.isArray(value)) throw new InvariantError("A distribution result is not an array");
  return value.map((item: unknown) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("leadId" in item) ||
      typeof item.leadId !== "string" ||
      !("to" in item)
    )
      throw new InvariantError("Invalid distribution item");
    const leadId = LeadId.parse(item.leadId);
    if (!leadId) throw new InvariantError("Invalid distribution lead ID");
    return { leadId, to: storedAgent(item.to) };
  });
}

function storedAgent(value: unknown): Assignment {
  if (
    typeof value !== "object" ||
    value === null ||
    !("ownerId" in value) ||
    !("teamId" in value) ||
    typeof value.ownerId !== "string" ||
    typeof value.teamId !== "string"
  )
    throw new InvariantError("Invalid distribution agent");
  const ownerId = UserId.parse(value.ownerId),
    teamId = TeamId.parse(value.teamId);
  if (!ownerId || !teamId) throw new InvariantError("Invalid distribution agent UUID");
  return { ownerId, teamId };
}

export async function submitDistribution(
  db: Db,
  actor: Actor,
  input: { readonly previewId: string; readonly fingerprint: string; readonly key: string },
  requestId: string,
): Promise<DistributionResult> {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    return idempotent(
      tx,
      current,
      {
        key: input.key,
        operation: "distribution.submit",
        request: { fingerprint: input.fingerprint, previewId: input.previewId },
      },
      storedResult,
      async (idempotencyId) => {
        if (!scopeHasRecords(recordScope(current, "lead", "assign")))
          throw new AccessError("accessDenied");
        const preview = await tx.distributionPreview.findUnique({ where: { id: input.previewId } });
        if (preview?.actorId !== current.userId || preview.fingerprint !== input.fingerprint)
          throw new AccessError("stalePreview");
        const request = preview.request;
        if (
          typeof request !== "object" ||
          request === null ||
          Array.isArray(request) ||
          !Array.isArray(request.agents) ||
          typeof request.excludePreviousOwner !== "boolean"
        )
          throw new InvariantError("Invalid preview request");
        const snapshot = preview.snapshot;
        if (!Array.isArray(snapshot)) throw new InvariantError("Invalid preview snapshot");
        for (const entry of snapshot) {
          if (
            typeof entry !== "object" ||
            entry === null ||
            Array.isArray(entry) ||
            typeof entry.id !== "string" ||
            typeof entry.version !== "number"
          )
            throw new InvariantError("Invalid preview lead");
          const id = LeadId.parse(entry.id);
          if (!id) throw new InvariantError("Invalid preview lead ID");
          const row = await scopedLead(tx, current, id, "assign");
          if (row.version !== entry.version || row.status !== "new")
            throw new AccessError("stalePreview");
        }
        const agents = request.agents.map(storedAgent);
        for (const to of agents) await agentFor(tx, current, to);
        const items = storedItems(request.items);
        for (const item of items)
          await applyAssignment(tx, current, item, "pool", {
            kind: "idempotency",
            id: idempotencyId,
            requestId,
          });
        return {
          items: items.map((item) => ({ leadId: item.leadId, to: { ...item.to } })),
          changed: true,
        };
      },
    );
  });
}

function storedResult(value: unknown): DistributionResult {
  if (
    typeof value !== "object" ||
    value === null ||
    !("items" in value) ||
    !("changed" in value) ||
    typeof value.changed !== "boolean"
  )
    throw new InvariantError("Invalid distribution result");
  return { items: storedItems(value.items), changed: value.changed };
}
