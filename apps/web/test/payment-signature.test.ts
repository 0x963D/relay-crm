import { expect, test } from "vitest";
import { signPaymentBody, verifyPaymentSignature } from "../src/server/payments/webhook.ts";

const secret = "fake-timestamp-boundary-secret-only";
const at = new Date("2031-07-15T12:00:00.000Z");
const body = new TextEncoder().encode("invented payload");

test.each([
  [-301, false],
  [-300, true],
  [0, true],
  [300, true],
  [301, false],
] as const)(
  "a signed timestamp offset by %s seconds has the expected boundary result",
  (offset, accepted) => {
    const timestamp = String(at.getTime() / 1000 + offset);
    expect(
      verifyPaymentSignature(secret, timestamp, signPaymentBody(secret, timestamp, body), body, at),
    ).toBe(accepted);
  },
);
