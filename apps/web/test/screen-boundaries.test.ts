import { describe, expect, test } from "vitest";
import { localCallback } from "../src/lib/display.ts";
import { ACCESS_FAILURES } from "@relay/domain";
import { failureMessages, authFailure, authMessages } from "../src/lib/failures.ts";
describe("screen boundaries", () => {
  test("callback inputs use the deployment timezone and reject a skipped clock time", () => {
    expect(localCallback("2031-07-15T09:30", "Europe/Bucharest")).toEqual(
      new Date("2031-07-15T06:30Z"),
    );
    expect(localCallback("2026-03-29T03:30", "Europe/Bucharest")).toBeNull();
    expect(localCallback("", "UTC")).toBeNull();
  });
  test("every typed refusal has one plain-words message", () => {
    expect(Object.keys(failureMessages).sort()).toEqual([...ACCESS_FAILURES].sort());
  });
});

test("sign-in distinguishes an invalid code from one that expired", async () => {
  expect(await authFailure(Response.json({ code: "OTP_EXPIRED" }, { status: 400 }), "code")).toBe(
    authMessages.OTP_EXPIRED,
  );
  expect(await authFailure(Response.json({ code: "INVALID_OTP" }, { status: 400 }), "code")).toBe(
    authMessages.INVALID_OTP,
  );
});
