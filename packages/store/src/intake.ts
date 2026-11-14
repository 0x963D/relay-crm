import {
  AccountId,
  IntakeEventId,
  LeadId,
  resolveIntake,
  type Intake,
  type IntakeDecision,
  type IntakeOutcome,
  type IntakeResult,
  type IntakeSnapshot,
  type IntakeSubmission,
  type LeadLifecycle,
  type LeadStatus,
  type ReopenReason,
} from "@relay/domain";
import { Prisma, type $Enums } from "./generated/client.ts";
import { InvariantError } from "./lead-row.ts";
import { findLeadIdentity, insertLead, updateLifecycle } from "./leads.ts";
import { transact, type Db, type Tx } from "./tx.ts";

const IN_THE_POOL: LeadLifecycle = {
  state: { status: "new" },
  firstAssignedAt: null,
  previousOwnerId: null,
};

/**
 * The one intake path for every source. Each attempt loads what the database holds, asks the
 * pure decision, and writes the result, all inside one SERIALIZABLE transaction. Nothing read
 * before the transaction is trusted, so a retry decides again from a fresh snapshot.
 */
export function intakeWith(db: Db): Intake {
  return (submission) =>
    transact(db, async (tx) => {
      const snapshot = await loadSnapshot(tx, submission);
      const decision = resolveIntake(snapshot, submission);
      return applyDecision(tx, decision, submission);
    });
}

async function loadSnapshot(tx: Tx, submission: IntakeSubmission): Promise<IntakeSnapshot> {
  const prior = await tx.intakeEvent.findUnique({
    where: {
      source_externalId: { source: submission.source, externalId: submission.externalId },
    },
    select: { id: true, outcome: true, leadId: true, accountId: true },
  });
  const lead = submission.email === null ? null : await findLeadIdentity(tx, submission.email);
  return {
    priorEvent:
      prior === null
        ? null
        : { id: branded(IntakeEventId, prior.id, "id"), outcome: outcomeFromRow(prior) },
    lead,
  };
}

/** Each arm is inserts and at most one update. It reads nothing and branches on nothing. */
async function applyDecision(
  tx: Tx,
  decision: IntakeDecision,
  submission: IntakeSubmission,
): Promise<IntakeResult> {
  switch (decision.kind) {
    case "replay":
      return { eventId: decision.eventId, outcome: decision.outcome, replayed: true };
    case "reject":
      return record(tx, submission, { kind: "rejectedNoEmail" });
    case "createLead": {
      const leadId = await insertLead(tx, {
        email: decision.email,
        name: submission.name,
        phone: submission.phone,
        lifecycle: IN_THE_POOL,
        createdAt: submission.receivedAt,
      });
      return record(tx, submission, { kind: "leadCreated", leadId });
    }
    case "attach":
      return record(tx, submission, { kind: "attachedToOpenLead", leadId: decision.leadId });
    case "reopen": {
      await updateLifecycle(tx, decision.leadId, decision.next);
      const result = await record(tx, submission, {
        kind: "leadReopened",
        leadId: decision.leadId,
      });
      await tx.activity.create({
        data: {
          kind: "statusChange",
          leadId: decision.leadId,
          detail: statusChangeDetail(
            decision.from.status,
            decision.next.state.status,
            decision.reason,
          ),
          at: submission.receivedAt,
        },
      });
      return result;
    }
    case "suppress":
      return record(tx, submission, { kind: "suppressedDoNotContact", leadId: decision.leadId });
    case "linkAccount":
      return record(tx, submission, { kind: "linkedToAccount", accountId: decision.accountId });
  }
}

/**
 * Writes the ledger row and, when the outcome has a subject, the timeline entry that points at
 * it. Every timestamp is the submission's `receivedAt`, so a retried body writes the same facts.
 */
async function record(
  tx: Tx,
  submission: IntakeSubmission,
  outcome: IntakeOutcome,
): Promise<IntakeResult> {
  const subject = subjectOf(outcome);
  const event = await tx.intakeEvent.create({
    data: {
      source: submission.source,
      externalId: submission.externalId,
      email: submission.email,
      name: submission.name,
      phone: submission.phone,
      campaign: submission.attribution.campaign,
      adSet: submission.attribution.adSet,
      ad: submission.attribution.ad,
      form: submission.attribution.form,
      submittedAt: submission.submittedAt,
      receivedAt: submission.receivedAt,
      raw: submission.raw ?? Prisma.JsonNull,
      outcome: outcome.kind,
      ...subject,
    },
    select: { id: true },
  });
  if (subject.leadId !== null || subject.accountId !== null) {
    await tx.activity.create({
      data: { kind: "intake", intakeEventId: event.id, at: submission.receivedAt, ...subject },
    });
  }
  return { eventId: branded(IntakeEventId, event.id, "id"), outcome, replayed: false };
}

interface Subject {
  readonly leadId: LeadId | null;
  readonly accountId: AccountId | null;
}

function subjectOf(outcome: IntakeOutcome): Subject {
  switch (outcome.kind) {
    case "leadCreated":
    case "attachedToOpenLead":
    case "leadReopened":
    case "suppressedDoNotContact":
      return { leadId: outcome.leadId, accountId: null };
    case "linkedToAccount":
      return { leadId: null, accountId: outcome.accountId };
    case "rejectedNoEmail":
      return { leadId: null, accountId: null };
  }
}

interface OutcomeColumns {
  readonly outcome: $Enums.IntakeOutcome;
  readonly leadId: string | null;
  readonly accountId: string | null;
}

function outcomeFromRow(row: OutcomeColumns): IntakeOutcome {
  switch (row.outcome) {
    case "leadCreated":
    case "attachedToOpenLead":
    case "leadReopened":
    case "suppressedDoNotContact":
      return { kind: row.outcome, leadId: branded(LeadId, row.leadId, "lead_id") };
    case "linkedToAccount":
      return { kind: row.outcome, accountId: branded(AccountId, row.accountId, "account_id") };
    case "rejectedNoEmail":
      return { kind: row.outcome };
  }
}

function branded<T extends string>(
  guard: { parse(value: string): T | null },
  value: string | null,
  column: string,
): T {
  const parsed = value === null ? null : guard.parse(value);
  if (parsed === null) {
    throw new InvariantError(`intake_events.${column} does not hold the ID its outcome needs`);
  }
  return parsed;
}

/** The stored shape of a status change. Written out field by field so it cannot drift silently. */
function statusChangeDetail(
  from: LeadStatus,
  to: LeadStatus,
  reason: ReopenReason,
): Prisma.InputJsonObject {
  return { from, to, reason: { kind: reason.kind, source: reason.source } };
}
