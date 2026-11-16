import { describe, expect, test } from "vitest";
import { formatMoney, localCallback, callbackDate, custodyDate } from "../src/lib/display.ts";
import { ACCESS_FAILURES } from "@relay/domain";
import { failureMessages, failureMessage, authFailure, authMessages } from "../src/lib/failures.ts";
describe("screen boundaries", () => {
  test("money keeps exact minor units beyond Number precision", () => {
    expect(formatMoney({ minor: 9223372036854775806n, currency: "GBP" })).toBe(
      "£92,233,720,368,547,758.06",
    );
    expect(formatMoney({ minor: 1234n, currency: "KWD" })).toBe("KWD\u00a01.234");
    expect(formatMoney({ minor: 42n, currency: "JPY" })).toBe("JP¥42");
  });
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
  test("callback labels use local calendar days across a clock change", () => {
    const now = new Date("2026-10-24T21:30:00Z");
    expect(callbackDate(new Date("2026-10-24T22:30:00Z"), "Europe/London", now)).toBe("23:30");
    expect(callbackDate(new Date("2026-10-25T09:30:00Z"), "Europe/London", now)).toBe("Sun 09:30");
    expect(callbackDate(new Date("2026-10-30T09:30:00Z"), "Europe/London", now)).toBe("Fri 09:30");
    expect(callbackDate(new Date("2026-10-31T09:30:00Z"), "Europe/London", now)).toBe(
      "31 Oct, 09:30",
    );
    expect(custodyDate(new Date("2026-10-10T09:30:00Z"), "Europe/London", true, now)).toBe(
      "since Sat 10 Oct",
    );
  });
  test("read and save errors distinguish a server response from a connection failure", () => {
    expect(failureMessage({ data: { code: "INTERNAL_SERVER_ERROR" } }, "read")).toContain(
      "not loaded",
    );
    expect(failureMessage({ data: { code: "INTERNAL_SERVER_ERROR" } }, "save")).toContain(
      "not saved",
    );
    expect(failureMessage({ data: { code: "INTERNAL_SERVER_ERROR" } })).not.toContain("connection");
    expect(failureMessage(new TypeError("Failed to fetch"), "read")).toContain("connection");
    const unavailable = {
      meta: { response: new Response("Service unavailable", { status: 503 }) },
    };
    expect(failureMessage(unavailable, "read")).toContain("The server could not complete");
    expect(failureMessage(unavailable, "save")).not.toContain("connection");
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
