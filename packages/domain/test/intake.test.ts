import { describe, expect, it } from "vitest";
import {
  isExternalId,
  normalizeAttribution,
  parseExternalId,
  resolveIntake,
  type IntakeDecision,
  type IntakeSnapshot,
  type LeadState,
} from "../src/index.ts";
import { submissionExample } from "../src/testing.ts";
import {
  accountId,
  ALL_STATES,
  ana,
  describeState,
  EARLIER,
  eventId,
  leadId,
  lifecycleOf,
  NOW,
} from "./fixtures.ts";

const EMPTY: IntakeSnapshot = { priorEvent: null, lead: null };

function snapshotWith(state: LeadState): IntakeSnapshot {
  return { priorEvent: null, lead: { id: leadId, lifecycle: lifecycleOf(state) } };
}

describe("resolveIntake", () => {
  it("creates a lead when the email is new", () => {
    const submission = submissionExample({ email: "Ana@Example.com" });
    expect(resolveIntake(EMPTY, submission)).toEqual({
      kind: "createLead",
      email: { asTyped: "Ana@Example.com", key: "ana@example.com" },
    });
  });

  it("rejects a submission with no usable email", () => {
    expect(resolveIntake(EMPTY, submissionExample({ email: null }))).toEqual({ kind: "reject" });
  });

  it("replays the first outcome before it looks at anything else", () => {
    const first = { kind: "leadCreated", leadId } as const;
    const snapshot: IntakeSnapshot = {
      priorEvent: { id: eventId, outcome: first },
      lead: {
        id: leadId,
        lifecycle: lifecycleOf({ status: "lost", assignee: ana, reason: "other" }),
      },
    };
    const expected: IntakeDecision = { kind: "replay", eventId, outcome: first };

    expect(resolveIntake(snapshot, submissionExample())).toEqual(expected);
    expect(resolveIntake(snapshot, submissionExample({ email: null }))).toEqual(expected);
  });

  /** The conflict rules as a specification: one decision for a lead in each example state. */
  const DECISIONS: readonly (readonly [state: string, decision: IntakeDecision["kind"]])[] = [
    ["new", "attach"],
    ["assigned", "attach"],
    ["working(contacted)", "attach"],
    ["working(callBack)", "attach"],
    ["working(noAnswer)", "attach"],
    ["won", "linkAccount"],
    ["lost(notInterested)", "reopen"],
    ["lost(badTiming)", "reopen"],
    ["dead(duplicate)", "reopen"],
    ["dead(wrongNumber)", "reopen"],
    ["dead(doNotContact)", "suppress"],
    ["dead(duplicate, from the pool)", "reopen"],
    ["dead(doNotContact, from the pool)", "suppress"],
  ];

  it("decides by the state of the lead that holds the email", () => {
    const decided = ALL_STATES.map((state) => [
      describeState(state),
      resolveIntake(snapshotWith(state), submissionExample()).kind,
    ]);
    expect(decided).toEqual(DECISIONS);
  });

  it("attaches to an open lead without changing it", () => {
    expect(
      resolveIntake(snapshotWith({ status: "assigned", assignee: ana }), submissionExample()),
    ).toEqual({ kind: "attach", leadId });
  });

  it("links the account of a won lead", () => {
    expect(
      resolveIntake(snapshotWith({ status: "won", assignee: ana, accountId }), submissionExample()),
    ).toEqual({ kind: "linkAccount", accountId });
  });

  it("reopens a closed lead into the pool, with the source as the reason", () => {
    const lost: LeadState = { status: "lost", assignee: ana, reason: "badTiming" };
    const submission = submissionExample({ source: "metaLeadAds", receivedAt: NOW });

    expect(resolveIntake(snapshotWith(lost), submission)).toEqual({
      kind: "reopen",
      leadId,
      from: lost,
      next: { state: { status: "new" }, firstAssignedAt: EARLIER, previousOwnerId: ana.ownerId },
      reason: { kind: "inbound", source: "metaLeadAds" },
    });
  });

  it("suppresses a submission for a lead that asked not to be contacted", () => {
    const state: LeadState = { status: "dead", assignee: ana, reason: "doNotContact" };
    expect(resolveIntake(snapshotWith(state), submissionExample())).toEqual({
      kind: "suppress",
      leadId,
    });
  });
});

describe("parseExternalId", () => {
  it("trims and accepts an ID of 1 to 200 characters", () => {
    expect(parseExternalId("  444555666  ")).toBe("444555666");
    expect(parseExternalId("a".repeat(200))).toBe("a".repeat(200));
  });

  it.each([
    ["an empty string", ""],
    ["only whitespace", "  "],
    ["more than 200 characters", "a".repeat(201)],
    ["a control character", "abc\u0000def"],
  ])("refuses %s", (_label, input) => {
    expect(parseExternalId(input)).toBeNull();
  });

  it("does not accept an untrimmed string as an ID", () => {
    expect(isExternalId(" 444 ")).toBe(false);
  });
});

describe("normalizeAttribution", () => {
  it("tidies each label and reads a missing or empty one as null", () => {
    expect(
      normalizeAttribution({ campaign: "  Spring\tsale ", adSet: "", ad: undefined, form: null }),
    ).toEqual({ campaign: "Spring sale", adSet: null, ad: null, form: null });
  });

  it("clips a label to 200 characters", () => {
    expect(normalizeAttribution({ campaign: "c".repeat(300) }).campaign).toBe("c".repeat(200));
  });
});
