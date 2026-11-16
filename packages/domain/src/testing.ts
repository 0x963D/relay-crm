import { parseEmail } from "./email.ts";
import { IntakeEventId, LeadId, type AccountId } from "./ids.ts";
import {
  normalizeAttribution,
  parseExternalId,
  type Intake,
  type IntakeResult,
  type IntakeSubmission,
  type JsonValue,
} from "./intake.ts";
import type { Assignment, IntakeSource, LeadStatus, StateOf } from "./lead.ts";

export interface LeadStateSeed {
  readonly assignee: Assignment;
  readonly accountId: AccountId;
  readonly callBackAt: Date;
}

export type LeadStateExamples = { readonly [S in LeadStatus]: readonly StateOf<S>[] };

export function leadStateExamples(seed: LeadStateSeed): LeadStateExamples {
  const { assignee, accountId, callBackAt } = seed;
  return {
    new: [{ status: "new" }],
    assigned: [{ status: "assigned", assignee }],
    working: [
      { status: "working", assignee, stage: { kind: "ready" } },
      { status: "working", assignee, stage: { kind: "contacted" } },
      { status: "working", assignee, stage: { kind: "callBack", at: callBackAt } },
      { status: "working", assignee, stage: { kind: "noAnswer", count: 2 } },
    ],
    won: [{ status: "won", assignee, accountId }],
    lost: [
      { status: "lost", assignee, reason: "notInterested" },
      { status: "lost", assignee, reason: "badTiming" },
    ],
    dead: [
      { status: "dead", assignee, reason: "duplicate" },
      { status: "dead", assignee, reason: "wrongNumber" },
      { status: "dead", assignee, reason: "doNotContact" },
      { status: "dead", assignee: null, reason: "duplicate" },
      { status: "dead", assignee: null, reason: "doNotContact" },
    ],
  };
}

export interface SubmissionFields {
  readonly source?: IntakeSource;
  readonly externalId?: string;
  readonly email?: string | null;
  readonly name?: string | null;
  readonly phone?: string | null;
  readonly campaign?: string | null;
  readonly submittedAt?: Date | null;
  readonly receivedAt?: Date;
  readonly raw?: JsonValue;
}

export function submissionExample(fields: SubmissionFields = {}): IntakeSubmission {
  const externalId = parseExternalId(fields.externalId ?? "example-1");
  if (externalId === null) throw new Error("submissionExample needs a usable external ID");

  const email = fields.email === null ? null : parseEmail(fields.email ?? "ana@example.com");
  if (email !== null && !email.ok) {
    throw new Error("submissionExample needs a valid email, or null for none");
  }

  return {
    source: fields.source ?? "webForm",
    externalId,
    email: email?.value ?? null,
    name: fields.name === undefined ? "Ana Silva" : fields.name,
    phone: fields.phone ?? null,
    attribution: normalizeAttribution({ campaign: fields.campaign }),
    submittedAt: fields.submittedAt ?? null,
    receivedAt: fields.receivedAt ?? new Date("2026-03-02T09:00:00.000Z"),
    raw: fields.raw ?? {},
  };
}

export function intakeResultExample(): IntakeResult {
  const eventId = IntakeEventId.parse("019a8e2c-0000-7000-8000-0000000000e1");
  const leadId = LeadId.parse("019a8e2c-0000-7000-8000-0000000001ea");
  if (eventId === null || leadId === null) throw new Error("The example IDs are not UUIDs");
  return { eventId, outcome: { kind: "leadCreated", leadId }, replayed: false };
}

export interface IntakeFake {
  readonly intake: Intake;
  readonly received: readonly IntakeSubmission[];
}

/**
 * A stand-in for the store's intake, for testing an intake source without a database. `respond`
 * picks the result, and a throw from it becomes the rejection a failed transaction would give.
 */
export function intakeFake(
  respond: (submission: IntakeSubmission) => IntakeResult = intakeResultExample,
): IntakeFake {
  const received: IntakeSubmission[] = [];
  return {
    received,
    intake: (submission) => {
      received.push(submission);
      return new Promise((resolve) => {
        resolve(respond(submission));
      });
    },
  };
}
