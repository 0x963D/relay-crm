import { createHash } from "node:crypto";
import {
  LeadId,
  UserId,
  TeamId,
  planDistribution,
  recordScope,
  transition,
  type Actor,
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
import { scopedLead, updateLifecycle, editLeadFields } from "./leads.ts";
import { transact, type Db, type Tx } from "./tx.ts";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function agentFor(tx: Tx, actor: Actor, to: Assignment): Promise<void> {
  const member = await tx.membership.findUnique({
    where: { userId_teamId: { userId: to.ownerId, teamId: to.teamId } },
    include: { user: true, team: true },
  });
  if (member?.user.role !== "agent" || member.team.kind !== "sales")
    throw new AccessError("invalidAgent");
  const scope = recordScope(actor, "lead", "assign");
  if (
    scope.kind === "none" ||
    (scope.kind !== "all" && (scope.kind !== "teamAndPool" || scope.teamId !== to.teamId))
  ) {
    throw new AccessError("accessDenied");
  }
}

export async function getLead(db: Db, actor: Actor, id: LeadId): Promise<Lead> {
  return transact(db, async (tx) =>
    leadFromRow(await scopedLead(tx, await currentActor(tx, actor), id, "read")),
  );
}

export async function editLead(
  db: Db,
  actor: Actor,
  id: LeadId,
  fields: { readonly name: string | null; readonly phone: string | null },
): Promise<Lead> {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    await scopedLead(tx, current, id, "edit");
    return editLeadFields(tx, id, fields);
  });
}

async function applyAssignment(
  tx: Tx,
  actor: Actor,
  item: DistributionItem,
  mode: "pool" | "owned",
): Promise<void> {
  const row = await scopedLead(tx, actor, item.leadId, "assign");
  if ((mode === "pool" && row.status !== "new") || (mode === "owned" && row.status === "new"))
    throw new AccessError("conflict");
  await agentFor(tx, actor, item.to);
  const before = lifecycleFromRow(row);
  const at = new Date();
  const next = transition(before, { type: "assign", to: item.to }, at);
  if (!next.ok) throw new AccessError("conflict");
  if (JSON.stringify(before) === JSON.stringify(next.value)) return;
  await updateLifecycle(tx, item.leadId, next.value);
  const detail = {
    to: { ...item.to },
    before: JSON.stringify(before),
    after: JSON.stringify(next.value),
  };
  await tx.activity.create({
    data: {
      kind: "assignment",
      leadId: item.leadId,
      detail: { actorId: actor.userId, ...detail },
      at,
    },
  });
  await tx.auditLog.create({
    data: {
      actorId: actor.userId,
      action: "leadAssigned",
      subjectId: item.leadId,
      before: { lifecycle: JSON.stringify(before) },
      after: { lifecycle: JSON.stringify(next.value) },
      at,
    },
  });
}

export async function assignPool(
  db: Db,
  actor: Actor,
  leadIds: readonly LeadId[],
  to: Assignment,
): Promise<DistributionResult> {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const items = [...new Set(leadIds)].sort().map((leadId) => ({ leadId, to }));
    if (items.length === 0) throw new AccessError("conflict");
    for (const item of items) await applyAssignment(tx, current, item, "pool");
    return { items };
  });
}
export async function reassignLead(
  db: Db,
  actor: Actor,
  leadId: LeadId,
  to: Assignment,
): Promise<DistributionResult> {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const item = { leadId, to };
    await applyAssignment(tx, current, item, "owned");
    return { items: [item] };
  });
}

export async function previewDistribution(
  db: Db,
  actor: Actor,
  request: DistributionRequest,
): Promise<DistributionPreview> {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    if (recordScope(current, "lead", "assign").kind === "none")
      throw new AccessError("accessDenied");
    const leads: DistributionLead[] = [];
    for (const id of [...new Set(request.leadIds)].sort()) {
      const row = await scopedLead(tx, current, id, "assign");
      if (row.status !== "new") throw new AccessError("conflict");
      leads.push({ id, version: row.version, lifecycle: lifecycleFromRow(row) });
    }
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
    const planned = planDistribution(leads, agents, request.excludePreviousOwner);
    if (!planned.ok) throw new AccessError(planned.error);
    const snapshot = leads.map((lead) => ({ id: lead.id, version: lead.version }));
    const storedRequest = {
      agents: agents.map((a) => ({ ...a })),
      excludePreviousOwner: request.excludePreviousOwner,
    };
    const fingerprint = digest({ actorId: current.userId, snapshot, request: storedRequest });
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
): Promise<DistributionResult> {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const scope = recordScope(current, "lead", "assign");
    if (scope.kind === "none") throw new AccessError("accessDenied");
    const prior = await tx.distribution.findUnique({
      where: { actorId_key: { actorId: current.userId, key: input.key } },
    });
    if (prior) {
      const items = storedItems(prior.result);
      for (const item of items) await scopedLead(tx, current, item.leadId, "assign");
      return { items };
    }
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
    const leads: DistributionLead[] = [];
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
      leads.push({ id, version: row.version, lifecycle: lifecycleFromRow(row) });
    }
    const agents = request.agents.map(storedAgent);
    for (const to of agents) await agentFor(tx, current, to);
    const plan = planDistribution(leads, agents, request.excludePreviousOwner);
    if (!plan.ok) throw new AccessError(plan.error);
    for (const item of plan.value) await applyAssignment(tx, current, item, "pool");
    await tx.distribution.create({
      data: {
        actorId: current.userId,
        key: input.key,
        result: plan.value.map((item) => ({ leadId: item.leadId, to: { ...item.to } })),
      },
    });
    return { items: plan.value };
  });
}
