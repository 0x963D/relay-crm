import { tidyText } from "./contact.ts";
import type { Email } from "./email.ts";
import type { AccountId, Brand, IntakeEventId, LeadId } from "./ids.ts";
import {
  isOpen,
  transition,
  type IntakeSource,
  type LeadLifecycle,
  type LeadState,
  type ReopenReason,
} from "./lead.ts";

/** A source's own ID for one submission. With the source, it is the idempotency key. */
export type ExternalId = Brand<string, "ExternalId">;

const MAX_EXTERNAL_ID = 200;
const MAX_LABEL = 200;

export function isExternalId(value: string): value is ExternalId {
  return (
    value.length >= 1 &&
    value.length <= MAX_EXTERNAL_ID &&
    value === value.trim() &&
    !/\p{Cc}/u.test(value)
  );
}

export function parseExternalId(input: string): ExternalId | null {
  const trimmed = input.trim();
  return isExternalId(trimmed) ? trimmed : null;
}

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Where a submission came from, as the source names it. */
export interface Attribution {
  readonly campaign: string | null;
  readonly adSet: string | null;
  readonly ad: string | null;
  readonly form: string | null;
}

/** Every intake source builds its attribution here, from whatever labels it has. */
export function normalizeAttribution(
  labels: Readonly<Partial<Record<keyof Attribution, string | null | undefined>>>,
): Attribution {
  return {
    campaign: tidyText(labels.campaign, MAX_LABEL),
    adSet: tidyText(labels.adSet, MAX_LABEL),
    ad: tidyText(labels.ad, MAX_LABEL),
    form: tidyText(labels.form, MAX_LABEL),
  };
}

export interface IntakeSubmission {
  readonly source: IntakeSource;
  readonly externalId: ExternalId;
  /** null when the record has no usable email. Intake still records it, as `rejectedNoEmail`. */
  readonly email: Email | null;
  readonly name: string | null;
  readonly phone: string | null;
  readonly attribution: Attribution;
  /** The source's own timestamp. null when it has none, so a report can say "unknown". */
  readonly submittedAt: Date | null;
  readonly receivedAt: Date;
  /** The original record, stored as received. */
  readonly raw: JsonValue;
}

/** Three shapes for the three subjects a ledger row can point at: a lead, an account, nothing. */
export type IntakeOutcome =
  | {
      readonly kind:
        "leadCreated" | "attachedToOpenLead" | "leadReopened" | "suppressedDoNotContact";
      readonly leadId: LeadId;
    }
  | { readonly kind: "linkedToAccount"; readonly accountId: AccountId }
  | { readonly kind: "rejectedNoEmail" };

export interface IntakeResult {
  readonly eventId: IntakeEventId;
  readonly outcome: IntakeOutcome;
  /** true when this external ID was already recorded. The outcome is the first one. */
  readonly replayed: boolean;
}

/** The port every intake source calls. The store implements it once. */
export type Intake = (submission: IntakeSubmission) => Promise<IntakeResult>;

/** Everything the database holds that the decision depends on. Two unique lookups fill it. */
export interface IntakeSnapshot {
  readonly priorEvent: { readonly id: IntakeEventId; readonly outcome: IntakeOutcome } | null;
  readonly lead: { readonly id: LeadId; readonly lifecycle: LeadLifecycle } | null;
}

export type IntakeDecision =
  | { readonly kind: "replay"; readonly eventId: IntakeEventId; readonly outcome: IntakeOutcome }
  | { readonly kind: "reject" }
  | { readonly kind: "createLead"; readonly email: Email }
  | { readonly kind: "linkAccount"; readonly accountId: AccountId }
  | { readonly kind: "attach"; readonly leadId: LeadId }
  | {
      readonly kind: "reopen";
      readonly leadId: LeadId;
      readonly from: LeadState;
      readonly next: LeadLifecycle;
      readonly reason: ReopenReason;
    }
  | { readonly kind: "suppress"; readonly leadId: LeadId };

/**
 * Decides what one submission does. It is pure and total. Every snapshot and submission has
 * exactly one decision, and the first matching rule wins.
 *
 * 1. The external ID was seen before: replay the first outcome, whatever this payload says.
 * 2. No usable email: reject, because email is the identity.
 * 3. No lead for the email: create one.
 * 4. The lead was won: link the account. A customer never re-enters the pool.
 * 5. The lead is open: attach.
 * 6. The lead is closed: ask the transition table. It reopens the lead or refuses, and a refusal
 *    suppresses the submission. Reopen policy lives in the table and nowhere else.
 */
export function resolveIntake(
  snapshot: IntakeSnapshot,
  submission: IntakeSubmission,
): IntakeDecision {
  const { priorEvent, lead } = snapshot;
  if (priorEvent !== null) {
    return { kind: "replay", eventId: priorEvent.id, outcome: priorEvent.outcome };
  }
  if (submission.email === null) return { kind: "reject" };
  if (lead === null) return { kind: "createLead", email: submission.email };

  const { state } = lead.lifecycle;
  if (state.status === "won") return { kind: "linkAccount", accountId: state.accountId };
  if (isOpen(state)) return { kind: "attach", leadId: lead.id };

  const reason: ReopenReason = { kind: "inbound", source: submission.source };
  const reopened = transition(lead.lifecycle, { type: "reopen", reason }, submission.receivedAt);
  return reopened.ok
    ? { kind: "reopen", leadId: lead.id, from: state, next: reopened.value, reason }
    : { kind: "suppress", leadId: lead.id };
}
