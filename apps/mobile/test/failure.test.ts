import { describe, expect, it } from "vitest";
import { mapFailure, remainingSeconds, retrySeconds } from "../src/core/failure.ts";

describe("request failures", () => {
  it("distinguishes network failure from an unanswered request", () => {
    expect(mapFailure({})).toEqual({ kind: "network" });
    expect(mapFailure({ timedOut: true })).toEqual({ kind: "noAnswer" });
  });
  it.each([400, 401, 403, 404, 429, 500, 502, 503])(
    "keeps HTTP %i separate from network failure",
    (status) => {
      expect(mapFailure({ status })).toEqual({ kind: "http", status });
    },
  );
  it.each(["accessDenied", "leadClosed", "idempotencyConflict", "futureReason"])(
    "preserves refusal %s",
    (reason) => {
      expect(mapFailure({ status: 403, accessFailure: reason })).toEqual({
        kind: "refused",
        status: 403,
        reason,
      });
    },
  );
  it.each([
    { status: 401, api: true },
    { code: "UNAUTHORIZED" },
    { status: 401, accessFailure: "accessDenied", api: true },
  ])("ends a session for %j", (input) => {
    expect(mapFailure(input)).toEqual({ kind: "sessionEnded", status: 401 });
  });
  it("does not turn an unreadable success or a gateway error into proof of a refused write", () => {
    expect(mapFailure({ status: 200, api: true, code: "UNAUTHORIZED" })).toEqual({
      kind: "unreadable",
      status: 200,
    });
    expect(mapFailure({ status: 503, api: true, code: "UNAUTHORIZED" })).toEqual({
      kind: "http",
      status: 503,
    });
  });
  it.each([
    [null, 60],
    ["", 60],
    ["-1", 60],
    ["abc", 60],
    ["48", 48],
    ["0", 0],
  ])("reads Retry-After %s", (input, expected) => {
    expect(retrySeconds(input)).toBe(expected);
  });
  it("uses a deadline across backgrounding and never returns negative seconds", () => {
    expect(remainingSeconds(48000, 1)).toBe(48);
    expect(remainingSeconds(48000, 47300)).toBe(1);
    expect(remainingSeconds(48000, 90000)).toBe(0);
  });
});
