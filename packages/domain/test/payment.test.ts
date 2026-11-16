import { expect, it } from "vitest";
import { transitionPayment, recordScope, type PaymentState, type Money } from "../src/index.ts";

const money: Money = { minor: 39500n, currency: "GBP" };
const at = new Date("2026-11-16T10:20:00Z");
it("completes only a matching provider observation and never completes review", () => {
  const provider = {
    type: "provider",
    result: { status: "completed", money },
    by: "reconciler",
  } as const;
  expect(transitionPayment({ status: "checkoutCreated" }, provider, money, at)).toEqual({
    status: "completed",
    at,
    by: "reconciler",
  });
  const review: PaymentState = {
    status: "needsReview",
    reason: "amount mismatch",
    reported: { ...money, minor: 1n },
    at,
  };
  expect(transitionPayment(review, provider, money, at)).toBe(review);
  expect(transitionPayment(review, { type: "closeReview", reason: " " }, money, at)).toBe(review);
  expect(
    transitionPayment(
      review,
      { type: "closeReview", reason: "Provider amount differed." },
      money,
      at,
    ),
  ).toEqual({ status: "failed", reason: "Provider amount differed.", at });
});
it.each([
  { minor: 1n, currency: "GBP" },
  { minor: 39500n, currency: "EUR" },
] satisfies Money[])("reviews a mismatched observation %#", (reported) => {
  expect(
    transitionPayment(
      { status: "checkoutCreated" },
      { type: "provider", result: { status: "completed", money: reported }, by: "providerWebhook" },
      money,
      at,
    ),
  ).toEqual({
    status: "needsReview",
    reason: reported.currency !== money.currency ? "currency mismatch" : "amount mismatch",
    reported,
    at,
  });
});
it("grants only the payment jobs their narrow system access", () => {
  for (const name of ["intake", "providerWebhook", "reconciler"] as const) {
    for (const record of ["lead", "account", "payment", "ledger"] as const) {
      expect(recordScope({ kind: "system", name }, record, "settle").kind).toBe(
        record === "payment" && name !== "intake" ? "all" : "none",
      );
      expect(recordScope({ kind: "system", name }, record, "reconcile").kind).toBe(
        record === "payment" && name === "reconciler" ? "all" : "none",
      );
    }
  }
});

it("manual completion needs two approvals and cannot use a provider event", () => {
  const pending: PaymentState = { status: "pendingApproval" };
  expect(transitionPayment(pending, { type: "approve", validApprovals: 1 }, money, at)).toBe(
    pending,
  );
  expect(transitionPayment(pending, { type: "approve", validApprovals: 2 }, money, at)).toEqual({
    status: "completed",
    by: "manualApproval",
    at,
  });
  expect(
    transitionPayment(
      pending,
      { type: "provider", by: "reconciler", result: { status: "completed", money } },
      money,
      at,
    ),
  ).toBe(pending);
  for (const type of ["reject", "cancel"] as const) {
    expect(transitionPayment(pending, { type, reason: " " }, money, at)).toBe(pending);
    const decided = transitionPayment(pending, { type, reason: "Wrong receipt" }, money, at);
    expect(decided).toEqual({
      status: type === "reject" ? "rejected" : "cancelled",
      reason: "Wrong receipt",
      at,
    });
    expect(transitionPayment(decided, { type: "approve", validApprovals: 2 }, money, at)).toBe(
      decided,
    );
  }
});

it.each(["failed", "expired"] as const)(
  "a paid report after %s needs a reasoned review",
  (status) => {
    const before: PaymentState =
      status === "failed" ? { status, reason: "closed", at } : { status, at };
    expect(
      transitionPayment(
        before,
        { type: "provider", by: "reconciler", result: { status: "completed", money } },
        money,
        at,
      ),
    ).toEqual({ status: "needsReview", reason: "paid after close", reported: money, at });
  },
);
