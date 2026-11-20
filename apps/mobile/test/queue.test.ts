import { queueGroup } from "@relay/domain";
import { describe, expect, it } from "vitest";
import { queueSections, rowPresentation, sourceLabel } from "../src/core/queue.ts";
import { at, queue, row } from "./fixtures.ts";

describe("queue presentation", () => {
  it("always shows the five groups with the server's counts", () => {
    const sections = queueSections(
      queue({
        counts: { overdueCallbacks: 137, dueToday: 0, noCallbackSet: 2, notYetCalled: 1, later: 0 },
      }),
    );
    expect(sections.map((s) => [s.key, s.count])).toEqual([
      ["overdueCallbacks", 137],
      ["dueToday", 0],
      ["noCallbackSet", 2],
      ["notYetCalled", 1],
      ["later", 0],
    ]);
    expect(sections[1]?.empty).toBe("Nothing else today.");
    expect(sections[0]?.rows).toEqual([]);
  });
  it("moves the same callback through later, today and overdue on the organisation's clock", () => {
    const lead = { callbackAt: new Date("2026-11-17T09:30:00Z"), hasAttempt: true };
    expect(queueGroup(lead, at, "UTC")).toBe("later");
    expect(queueGroup(lead, new Date("2026-11-17T00:00:00Z"), "UTC")).toBe("dueToday");
    expect(queueGroup(lead, new Date("2026-11-17T09:30:00.001Z"), "UTC")).toBe("overdueCallbacks");
  });
  it.each([
    [false, "notYetCalled"],
    [true, "noCallbackSet"],
    [null, "noCallbackSet"],
  ])("groups a lead with hasAttempt %s", (hasAttempt, expected) => {
    expect(
      queueGroup(
        { callbackAt: null, hasAttempt: typeof hasAttempt === "boolean" ? hasAttempt : null },
        at,
        "UTC",
      ),
    ).toBe(expected);
  });
  it("uses the email for a missing name and shortens only the campaign", () => {
    const p = rowPresentation({ ...row, name: null }, "notYetCalled", at, "UTC");
    expect(p.name).toBe("lead@example.com");
    expect(p.line).toBe("IELTS evening · Assigned 14:00 · Meta Lead Ads");
    expect(p.slips[0]?.text).toBe("New to you");
  });
  it("uses the honest Attempt logged fallback after a note", () => {
    const p = rowPresentation(
      { ...row, hasAttempt: true, lastNoteOrOutcome: { kind: "note", note: "Price by email" } },
      "noCallbackSet",
      at,
      "UTC",
    );
    expect(p.slips).toEqual([{ text: "Attempt logged", kind: "mute", icon: "phone" }]);
    expect(p.line).toBe("IELTS evening · Price by email");
  });
  it.each([
    "No answer.",
    " RANG OUT. ",
    "Left a voicemail",
    "Line busy",
    "Message sent, no reply",
    "One tick only",
  ])("omits routine no-answer note %s", (note) => {
    const p = rowPresentation(
      {
        ...row,
        noAnswerCount: 2,
        lastNoteOrOutcome: {
          kind: "attempt",
          note,
          outcome: "noAnswer",
          channel: "call",
          callbackAt: null,
          noAnswerCount: null,
        },
      },
      "noCallbackSet",
      at,
      "UTC",
    );
    expect(p.line).toBe("IELTS evening");
    expect(p.slips.map((s) => s.text)).toEqual(["No answer ×2"]);
  });
  it("keeps a meaningful note and adds the unanswered count without repeating it", () => {
    const p = rowPresentation(
      {
        ...row,
        callbackAt: new Date("2026-11-15T09:30:00Z"),
        noAnswerCount: 2,
        lastNoteOrOutcome: { kind: "note", note: "Call after work" },
      },
      "overdueCallbacks",
      at,
      "UTC",
    );
    expect(p.slips.map((s) => s.text)).toEqual(["Since Sun 09:30", "No answer ×2"]);
    expect(p.label).toContain("Overdue Since Sun 09:30");
    expect(p.line).toBe("IELTS evening · Call after work");
  });
  it.each([
    ["dueToday", "20:00"],
    ["later", "20:00"],
  ] as const)("presents %s callback", (group, text) => {
    expect(
      rowPresentation({ ...row, callbackAt: new Date("2026-11-16T20:00:00Z") }, group, at, "UTC")
        .slips[0]?.text,
    ).toBe(text);
  });
  it("shows no campaign and no note honestly", () => {
    expect(rowPresentation({ ...row, campaign: null }, "noCallbackSet", at, "UTC").line).toBe(
      "No campaign · No note yet",
    );
  });
  it.each([
    ["webForm", "Web form"],
    ["csv", "CSV import"],
    ["manual", "Manual entry"],
    [null, "Unknown source"],
  ])("labels source %s", (source, expected) => {
    expect(sourceLabel(source)).toBe(expected);
  });
});
