import { expect, test } from "vitest";
import { receiptPresentation } from "../src/lib/payments.ts";

test("sending hides the previous unknown outcome", () => {
  expect(
    receiptPresentation({ processing: true, state: "unknown", nextAttemptAt: null }, 100),
  ).toMatchObject({ outcome: "sending", explainUnknown: false });
});
test("an elapsed retry time becomes queued instead of a future promise", () => {
  const receipt = { processing: false, state: "failed" as const, nextAttemptAt: new Date(1000) };
  expect(receiptPresentation(receipt, 999)).toMatchObject({
    outcome: "scheduled",
    nextAttemptAt: new Date(1000),
  });
  expect(receiptPresentation(receipt, 1000)).toMatchObject({
    outcome: "queued",
    nextAttemptAt: null,
  });
});
