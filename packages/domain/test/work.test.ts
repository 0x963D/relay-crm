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
  expect(queueGroup({ callbackAt: new Date(tomorrow), hasAttempt: true }, at, zone)).toBeNull();
  expect(queueGroup({ callbackAt: null, hasAttempt: false }, at, zone)).toBe("notYetCalled");
  expect(queueGroup({ callbackAt: null, hasAttempt: true }, at, zone)).toBeNull();
  expect(queueGroup({ callbackAt: null, hasAttempt: null }, at, zone)).toBeNull();
});
