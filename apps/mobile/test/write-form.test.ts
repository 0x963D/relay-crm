import { expect, it } from "vitest";
import { ActivityId } from "@relay/domain";
import type { Lead } from "../src/core/api-types.ts";
import {
  appendQuickNote,
  callbackShortcuts,
  closingAvailability,
  formCommand,
  initialDraft,
  inOneHour,
  wallInstant,
  wallTime,
} from "../src/core/write-form.ts";
import {
  entryCaption,
  removalWords,
  storedCounts,
  writeBand,
} from "../src/core/write-presentation.ts";
import { row } from "./fixtures.ts";
import { command, draft, id, key, now } from "./write-fixtures.ts";
import type { Entry, WriteSnapshot } from "../src/core/write-model.ts";

it("rounds an hour from each tap and freezes the absolute instant in the payload", () => {
  expect(inOneHour(new Date("2026-11-17T14:02:00Z")).toISOString()).toBe(
    "2026-11-17T15:05:00.000Z",
  );
  expect(inOneHour(new Date("2026-11-17T14:05:00Z")).toISOString()).toBe(
    "2026-11-17T15:05:00.000Z",
  );
  const at = inOneHour(now).toISOString();
  const payload = formCommand({ ...draft, callbackAt: at }, key, now);
  expect(payload).toMatchObject({ payload: { callback: { kind: "set", at } } });
});
it("shortcuts use the organisation's day, independently of the phone's zone", () => {
  const choices = callbackShortcuts(new Date("2026-11-17T22:00:00Z"), "Asia/Tokyo");
  expect(choices.find((item) => item.label === "Today 18:00")?.at.toISOString()).toBe(
    "2026-11-18T09:00:00.000Z",
  );
  expect(choices.find((item) => item.label === "Tomorrow 09:00")?.at.toISOString()).toBe(
    "2026-11-19T00:00:00.000Z",
  );
  expect(
    callbackShortcuts(new Date("2026-11-17T19:00:00Z"), "Europe/London").map((item) => item.label),
  ).not.toContain("Today 18:00");
});
it("rejects a nonexistent wall time and takes the earlier instant of a repeated one", () => {
  expect(
    wallInstant({ year: 2027, month: 3, day: 28, hour: 1, minute: 30 }, "Europe/London"),
  ).toBeNull();
  expect(
    wallInstant(
      { year: 2027, month: 10, day: 31, hour: 1, minute: 30 },
      "Europe/London",
    )?.toISOString(),
  ).toBe("2027-10-31T00:30:00.000Z");
  expect(wallTime(new Date("2026-11-17T12:00:00Z"), "Asia/Kolkata")).toMatchObject({
    hour: 17,
    minute: 30,
  });
});
it("initial callback values preserve a future callback and replace an overdue one only when asked", () => {
  const future = new Date(now.getTime() + 7200000);
  const past = new Date(now.getTime() - 7200000);
  expect(
    initialDraft({ id, name: "Lead", operation: "attempt", callback: future, now }).callbackAt,
  ).toBe(future.toISOString());
  expect(
    initialDraft({ id, name: "Lead", operation: "attempt", callback: past, now }).callbackAt,
  ).toBeNull();
  expect(
    initialDraft({ id, name: "Lead", operation: "callback", callback: past, now }).callbackAt,
  ).toBe(inOneHour(now).toISOString());
});
it("notes trim like the server, count UTF-16 units and append quick notes without exceeding the limit", () => {
  expect(formCommand({ ...draft, note: " \n " }, key, now)).toHaveProperty("field", "note");
  expect(formCommand({ ...draft, note: "  Hi 😀  " }, key, now)).toMatchObject({
    payload: { note: "Hi 😀" },
  });
  expect(appendQuickNote("Tried", "Rang out")).toBe("Tried. Rang out");
  expect(appendQuickNote("Tried!", "Rang out")).toBe("Tried! Rang out");
  expect(appendQuickNote("x".repeat(3990), "Rang out")).toBe("x".repeat(3990) + ". Rang out");
  expect(appendQuickNote("x".repeat(3991), "Rang out")).toBeNull();
});
const lead: Lead = {
  ...row,
  contactedAt: null,
  lostNote: null,
  custody: { receivedFrom: null, assignedBy: null, heldBy: null },
  attribution: null,
  timeline: [],
};
it("closing follows the server lifecycle, including a callback with no attempt", () => {
  const state = row.lifecycle.state;
  if (state.status !== "assigned") throw new Error("Expected an assigned fixture.");
  expect(closingAvailability(lead, now)).toEqual({
    won: false,
    lost: false,
    duplicate: true,
    wrongNumber: false,
    doNotContact: true,
  });
  expect(
    closingAvailability(
      {
        ...lead,
        lifecycle: {
          ...lead.lifecycle,
          state: {
            status: "working",
            assignee: state.assignee,
            stage: { kind: "callBack", at: inOneHour(now) },
          },
        },
      },
      now,
    ),
  ).toEqual({ won: true, lost: true, duplicate: true, wrongNumber: false, doNotContact: true });
  const current = {
    ...lead,
    lifecycle: {
      ...lead.lifecycle,
      state: { status: "working", assignee: state.assignee, stage: { kind: "ready" } },
    },
  } satisfies Lead;
  expect(closingAvailability(current, now, "invalidTransition")).toMatchObject({
    won: false,
    lost: false,
  });
});
it("wrong number compares sequence with the newest assignment, even when times tie", () => {
  const activityId = ActivityId.parse("00000000-0000-4000-8000-000000000003");
  if (!activityId || row.lifecycle.state.status !== "assigned") throw new Error("Invalid fixture.");
  const activity: Lead["timeline"][number] = {
    id: activityId,
    leadId: row.id,
    accountId: null,
    intakeEventId: null,
    kind: "assignment",
    at: now,
    sequence: 2n,
    detail: null,
    summary: null,
    actor: null,
  };
  const working: Lead = {
    ...lead,
    lifecycle: {
      ...lead.lifecycle,
      state: {
        status: "working",
        assignee: row.lifecycle.state.assignee,
        stage: { kind: "ready" },
      },
    },
    timeline: [{ ...activity, kind: "attempt", sequence: 1n }, activity],
  };
  expect(closingAvailability(working, now).wrongNumber).toBe(false);
  expect(
    closingAvailability(
      {
        ...working,
        timeline: [...working.timeline, { ...activity, kind: "attempt", sequence: 3n }],
      },
      now,
    ).wrongNumber,
  ).toBe(true);
  expect(
    closingAvailability(
      {
        ...working,
        timeline: [...working.timeline, { ...activity, kind: "attempt", sequence: 3n }],
      },
      now,
      "wrongNumberNeedsAnAttempt",
    ).wrongNumber,
  ).toBe(false);
});
it("refused retries never claim the first request was not saved", () => {
  const entry: Entry = {
    command,
    draft,
    status: "refused",
    attempt: 2,
    followsUnknown: true,
    refusal: "accessDenied",
    savedAt: now.toISOString(),
    unknownCause: null,
  };
  const snapshot: WriteSnapshot = {
    state: "refusedAfterUnknown",
    entry,
    view: "refusedAfterUnknown",
    storageError: null,
    receipt: null,
  };
  expect(writeBand(snapshot, true)?.title).not.toMatch(/not saved/i);
  expect(writeBand(snapshot, true)?.text).toContain("first try may have saved");
  expect(entryCaption(snapshot)).toBe("May or may not be on the timeline");
  expect(removalWords(snapshot, true).text).toContain("may already hold it");
});
it("sign-out names every stored kind and does not invent a count", () => {
  expect(storedCounts({ entries: 1, drafts: 2 })).toBe("1 unresolved entry and 2 drafts");
  expect(storedCounts({ entries: 0, drafts: 0 })).toBe("");
});
