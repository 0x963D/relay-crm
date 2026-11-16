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

test("open leads match an independent partition across offsets, DST changes and midnight", () => {
  const day = 86400000;
  const fixtures = Array.from({ length: 26 }, (_, index) => {
    const offset = index - 11;
    const start = Date.parse("2027-06-01T00:00:00Z") - offset * 3600000;
    return {
      zone: offset === 0 ? "UTC" : `Etc/GMT${offset > 0 ? "-" : "+"}${String(Math.abs(offset))}`,
      start,
      end: start + day,
    };
  });
  fixtures.push(
    {
      zone: "America/Los_Angeles",
      start: Date.parse("2027-03-14T08:00:00Z"),
      end: Date.parse("2027-03-15T07:00:00Z"),
    },
    {
      zone: "America/Los_Angeles",
      start: Date.parse("2027-11-07T07:00:00Z"),
      end: Date.parse("2027-11-08T08:00:00Z"),
    },
    {
      zone: "Europe/Bucharest",
      start: Date.parse("2027-03-27T22:00:00Z"),
      end: Date.parse("2027-03-28T21:00:00Z"),
    },
    {
      zone: "Europe/Bucharest",
      start: Date.parse("2027-10-30T21:00:00Z"),
      end: Date.parse("2027-10-31T22:00:00Z"),
    },
  );
  let seed = 123456;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (const { zone, start, end } of fixtures) {
    for (const now of [start, start + 1, end - 1, start + (random() % (end - start))]) {
      const callbacks = [
        start - 1,
        start,
        now - 1,
        now,
        now + 1,
        end - 1,
        end,
        end + 1,
        start + (random() % (2 * day)),
      ];
      const leads = [
        { kind: "untouched", callbackAt: null, hasAttempt: false },
        { kind: "notes-only", callbackAt: null, hasAttempt: false },
        { kind: "cleared-callback", callbackAt: null, hasAttempt: false },
        { kind: "reassigned", callbackAt: null, hasAttempt: false },
        { kind: "reopened", callbackAt: null, hasAttempt: false },
        { kind: "unknown-attempts", callbackAt: null, hasAttempt: null },
        ...callbacks.map((time) => ({
          kind: "callback",
          callbackAt: new Date(time),
          hasAttempt: true,
        })),
      ];
      for (const lead of leads) {
        const callback = lead.callbackAt?.getTime();
        const oracle = {
          overdueCallbacks: callback !== undefined && callback < now,
          dueToday:
            callback !== undefined && callback >= now && callback >= start && callback < end,
          later: callback !== undefined && callback >= now && callback >= end,
          notYetCalled: callback === undefined && lead.hasAttempt === false,
          noCallbackSet: callback === undefined && lead.hasAttempt !== false,
        };
        const memberships = Object.entries(oracle)
          .filter(([, admitted]) => admitted)
          .map(([group]) => group);
        expect(memberships, `${zone} ${new Date(now).toISOString()} ${lead.kind}`).toHaveLength(1);
        expect(queueGroup(lead, new Date(now), zone)).toBe(memberships[0]);
      }
    }
  }
});

test("a later callback becomes due today at the organisation's midnight", () => {
  const lead = { callbackAt: new Date("2026-11-17T08:00:00Z"), hasAttempt: true };
  expect(queueGroup(lead, new Date("2026-11-16T21:59:59Z"), "Europe/Bucharest")).toBe("later");
  expect(queueGroup(lead, new Date("2026-11-16T22:00:00Z"), "Europe/Bucharest")).toBe("dueToday");
});
