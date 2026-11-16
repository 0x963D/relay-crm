import { expect, test } from "vitest";
import { groupPaymentEvents } from "../src/lib/payments.ts";

test("consecutive unchanged checks collapse with their count and first and last times", () => {
  const check = (minute: number, status = "pending") => ({
    kind: "reconcilerCheck",
    at: new Date(Date.UTC(2026, 10, 17, 12, minute)),
    detail: { changed: false, providerStatus: status, status: "checkoutCreated" },
  });
  const checks = [
    check(1),
    check(2),
    check(3),
    { ...check(4), kind: "webhookDelivery" },
    check(5),
    check(6, "failed"),
  ];
  expect(
    groupPaymentEvents(checks).map(({ event, count, lastAt }) => [
      event.at.getUTCMinutes(),
      count,
      lastAt.getUTCMinutes(),
    ]),
  ).toEqual([
    [1, 3, 3],
    [4, 1, 4],
    [5, 1, 5],
    [6, 1, 6],
  ]);
});
