import { describe, expect, it } from "vitest";
import {
  clock,
  contextualDate,
  dayHeading,
  nextMidnight,
  nextQueueRefresh,
  overdue,
  zoneName,
} from "../src/core/dates.ts";
import { at } from "./fixtures.ts";

describe("the organisation's clock", () => {
  it.each([
    ["Europe/London", "14:00"],
    ["America/New_York", "09:00"],
    ["Asia/Tokyo", "23:00"],
  ])("formats %s independently of the phone", (zone, expected) => {
    expect(clock(at, zone)).toBe(expected);
  });
  it("uses the organisation's local day", () => {
    expect(dayHeading(new Date("2026-11-16T23:30:00Z"), "Europe/Bucharest")).toBe("Tue 17 Nov");
  });
  it.each([
    ["2026-11-16T20:00:00Z", "20:00"],
    ["2026-11-17T09:30:00Z", "Tue 09:30"],
    ["2026-11-22T09:30:00Z", "Sun 09:30"],
    ["2026-11-23T09:30:00Z", "23 Nov, 09:30"],
    ["2026-11-15T09:30:00Z", "15 Nov, 09:30"],
    ["2027-01-14T10:30:00Z", "14 Jan 2027, 10:30"],
  ])("formats callback %s", (input, expected) => {
    expect(contextualDate(new Date(input), at, "Europe/London", "callback")).toBe(expected);
  });
  it("does not use a weekday for an earlier timeline entry", () => {
    expect(contextualDate(new Date("2026-11-15T09:30:00Z"), at, "Europe/London", "timeline")).toBe(
      "15 Nov, 09:30",
    );
  });
  it("formats custody, checked and session contexts separately", () => {
    expect(contextualDate(at, at, "UTC", "custody")).toBe("Mon 16 Nov");
    expect(contextualDate(new Date("2025-11-02T09:00:00Z"), at, "UTC", "custody")).toBe(
      "2 Nov 2025",
    );
    expect(contextualDate(new Date("2026-11-15T09:30:00Z"), at, "UTC", "checked")).toBe(
      "Sun 09:30",
    );
    expect(contextualDate(at, at, "UTC", "session")).toBe("Mon 16 Nov, 14:00");
  });
  it.each([
    [23, "23 min"],
    [1380, "23 h 0 min"],
    [1710, "Since Sun 09:30"],
    [10080, "Since 9 Nov, 14:00"],
  ])("formats overdue after %i minutes", (minutes, expected) => {
    expect(overdue(new Date(at.getTime() - minutes * 60000), at, "UTC")).toBe(expected);
  });
  it.each([
    ["2026-03-29T00:00:00Z", "2026-03-29T23:00:00.000Z"],
    ["2026-10-24T23:00:00Z", "2026-10-26T00:00:00.000Z"],
  ])("finds local midnight across clock changes from %s", (input, expected) => {
    expect(nextMidnight(new Date(input), "Europe/London").toISOString()).toBe(expected);
  });
  it("refreshes just after the next callback, or at midnight", () => {
    expect(nextQueueRefresh(at, "UTC", new Date(at.getTime() + 1000))).toBe(1001);
    expect(nextQueueRefresh(at, "UTC", null)).toBe(10 * 3600000);
    expect(nextQueueRefresh(at, "UTC", new Date(at.getTime() - 1))).toBe(10 * 3600000);
  });
  it.each([
    ["America/New_York", "New York"],
    ["UTC", "UTC"],
    ["Europe/London", "London"],
  ])("names %s as a place", (input, expected) => {
    expect(zoneName(input)).toBe(expected);
  });
});

it("keeps the date and omits clock times until the organisation zone is known", () => {
  expect(clock(at, undefined)).toBe("");
  expect(contextualDate(at, at, undefined, "session")).toBe("Mon 16 Nov");
  expect(contextualDate(at, at, undefined, "timeline")).toBe("Mon 16 Nov");
});
