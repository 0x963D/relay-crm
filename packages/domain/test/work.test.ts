import { expect, test } from "vitest";
import { queueGroup } from "../src/index.ts";

test.each([
  ["Asia/Tokyo", "2026-11-16T16:00:00Z", "2026-11-17T01:00:00Z", "2026-11-17T15:00:00Z"],
  ["America/Los_Angeles", "2026-11-17T01:00:00Z", "2026-11-17T07:00:00Z", "2026-11-17T08:00:00Z"],
])("groups callbacks at the local day boundary in %s", (zone, now, today, tomorrow) => {
  const at = new Date(now);
  expect(queueGroup({ callbackAt: new Date(at.getTime() - 1), hasAttempt: true }, at, zone)).toBe(
    "overdueCallbacks",
  );
  expect(queueGroup({ callbackAt: new Date(today), hasAttempt: true }, at, zone)).toBe("dueToday");
  expect(queueGroup({ callbackAt: new Date(tomorrow), hasAttempt: true }, at, zone)).toBe("later");
  expect(queueGroup({ callbackAt: null, hasAttempt: false }, at, zone)).toBe("notYetCalled");
  expect(queueGroup({ callbackAt: null, hasAttempt: true }, at, zone)).toBe("noCallbackSet");
  expect(queueGroup({ callbackAt: null, hasAttempt: null }, at, zone)).toBe("noCallbackSet");
});

test("every open lead belongs to exactly one queue group at any time", () => {
  const groups = ["overdueCallbacks", "dueToday", "noCallbackSet", "notYetCalled", "later"];
  let seed = 123456;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let index = 0; index < 2000; index += 1) {
    const at = new Date(random() * 1000);
    const callbackAt = random() % 3 === 0 ? null : new Date(random() * 1000);
    const hasAttempt = [true, false, null][random() % 3] ?? null;
    const group = queueGroup({ callbackAt, hasAttempt }, at, "Europe/Bucharest");
    expect(groups.filter((candidate) => candidate === group)).toHaveLength(1);
  }
});

test("a later callback becomes due today at the organisation's midnight", () => {
  const lead = { callbackAt: new Date("2026-11-17T08:00:00Z"), hasAttempt: true };
  expect(queueGroup(lead, new Date("2026-11-16T21:59:59Z"), "Europe/Bucharest")).toBe("later");
  expect(queueGroup(lead, new Date("2026-11-16T22:00:00Z"), "Europe/Bucharest")).toBe("dueToday");
});
