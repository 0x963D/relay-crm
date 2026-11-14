import { parseEmail } from "./email.ts";
import type { AccountId } from "./ids.ts";
import {
  normalizeAttribution,
  parseExternalId,
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

/**
 * Example lead states that cover every variant of every status. The return type is keyed by
 * status, so a new status does not compile until it has examples. Tests in other packages build
 * their fixtures from these, which keeps "every state" one list.
 */
export function leadStateExamples(seed: LeadStateSeed): LeadStateExamples {
  const { assignee, accountId, callBackAt } = seed;
  return {
    new: [{ status: "new" }],
    assigned: [{ status: "assigned", assignee }],
    working: [
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
  /** null builds a submission with no usable email. */
  readonly email?: string | null;
  readonly name?: string | null;
  readonly phone?: string | null;
  readonly campaign?: string | null;
  readonly submittedAt?: Date | null;
  readonly receivedAt?: Date;
  readonly raw?: JsonValue;
}

/** A valid submission for tests. Pass only the fields the test is about. */
export function submissionExample(fields: SubmissionFields = {}): IntakeSubmission {
  const externalId = parseExternalId(fields.externalId ?? "example-1");
  if (externalId === null) throw new Error("submissionExample needs a usable external ID");

  const email = fields.email === null ? null : parseEmail(fields.email ?? "ana@example.com");
  if (fields.email !== null && email === null) {
    throw new Error("submissionExample needs a valid email, or null for none");
  }

  return {
    source: fields.source ?? "webForm",
    externalId,
    email,
    name: fields.name === undefined ? "Ana Silva" : fields.name,
    phone: fields.phone ?? null,
    attribution: normalizeAttribution({ campaign: fields.campaign }),
    submittedAt: fields.submittedAt ?? null,
    receivedAt: fields.receivedAt ?? new Date("2026-03-02T09:00:00.000Z"),
    raw: fields.raw ?? {},
  };
}
