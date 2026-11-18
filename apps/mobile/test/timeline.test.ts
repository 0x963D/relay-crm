import { describe, expect, it } from "vitest";
import { ActivityId } from "@relay/domain";
import type { Lead } from "../src/core/api-types.ts";
import { timelinePresentation } from "../src/core/timeline.ts";
import { at, row } from "./fixtures.ts";

const id = ActivityId.parse("40000000-0000-4000-8000-000000000001");
const newer = ActivityId.parse("40000000-0000-4000-8000-000000000002");
if (!id || !newer) throw new Error("Invalid timeline fixture.");
const entry: Lead["timeline"][number] = {
  id,
  leadId: row.id,
  accountId: null,
  intakeEventId: null,
  kind: "assignment",
  at,
  sequence: 1n,
  detail: { to: { ownerId: "agent" } },
  summary: null,
  actor: null,
};
const lead: Lead = {
  ...row,
  contactedAt: null,
  lostNote: null,
  noAnswerCount: 0,
  custody: {
    receivedFrom: null,
    assignedBy: null,
    heldBy: { id: "agent", name: "Dele Akinwale", since: at },
  },
  attribution: null,
  timeline: [entry],
};
describe("honest timeline labels", () => {
  it("names the recipient only for the current assignment", () => {
    expect(timelinePresentation(entry, lead, "agent", at, "UTC").title).toBe("Assigned to you");
    expect(
      timelinePresentation(
        entry,
        { ...lead, timeline: [{ ...entry, id: newer, sequence: 2n }, entry] },
        "agent",
        at,
        "UTC",
      ).title,
    ).toBe("Lead assigned");
  });
  it("does not invent a recipient or actor when they are absent", () => {
    const p = timelinePresentation({ ...entry, detail: null }, lead, "agent", at, "UTC");
    expect(p.title).toBe("Lead assigned");
    expect(p.body).toBe("Assignment recorded");
    expect(p.actor).toBeNull();
  });
  it("does not infer an outcome from an unstructured attempt", () => {
    expect(
      timelinePresentation({ ...entry, kind: "attempt", detail: null }, lead, "agent", at, "UTC"),
    ).toMatchObject({ title: "Attempt logged", body: "", actor: null });
  });
  it("keeps intake details in the details section", () => {
    expect(
      timelinePresentation({ ...entry, kind: "intake" }, lead, "agent", at, "UTC"),
    ).toMatchObject({ title: "Lead received", body: "" });
  });
  it("uses You for the actor and keeps the closure reason", () => {
    expect(
      timelinePresentation(
        {
          ...entry,
          kind: "closure",
          actor: { id: "agent", name: "Dele Akinwale" },
          detail: { closing: { kind: "dead", reason: "doNotContact" } },
        },
        lead,
        "agent",
        at,
        "UTC",
      ),
    ).toMatchObject({ title: "Closed as dead", body: "Do not contact", actor: "You" });
  });
});

it("includes the recorded callback in a timeline entry's presentation", () => {
  expect(
    timelinePresentation(
      {
        ...entry,
        kind: "attempt",
        summary: {
          kind: "attempt",
          channel: "call",
          outcome: "spokeToThem",
          note: "Tomorrow",
          callbackAt: at,
          noAnswerCount: null,
        },
      },
      lead,
      "agent",
      at,
      "UTC",
    ).callback,
  ).toBe("Callback 14:00");
});
