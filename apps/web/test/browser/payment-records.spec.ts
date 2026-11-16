import { test, expect } from "@playwright/test";
import { signIn, rpc } from "./support.ts";
import { browserState } from "./paths.ts";

test("review compares the fact that differs, including a paid report after expiry", async ({
  page,
}) => {
  await signIn(page, "accountant");
  const payments = await rpc(page).payments.list.query({ limit: 100 });
  const late = payments.needsReview.find(
    (payment) =>
      payment.state.status === "needsReview" && payment.state.reason === "paid after close",
  );
  expect(late).toBeDefined();
  await page.goto(`${browserState().url}/payments/${late!.id}`);
  const comparison = page.getByRole("region", { name: "Review comparison" });
  await expect(comparison).toContainText("Expired");
  await expect(comparison).toContainText("Paid");
  await expect(comparison).toContainText("The state");
  await expect(comparison).toContainText("The amount and the currency match.");
  const mismatch = payments.needsReview.find(
    (payment) =>
      payment.state.status === "needsReview" && payment.state.reason === "amount mismatch",
  );
  expect(mismatch).toBeDefined();
  await page.goto(`${browserState().url}/payments/${mismatch!.id}`);
  await expect(comparison).toContainText("The amount. The currency matches.");
  await expect(comparison).not.toContainText("The state");
});
