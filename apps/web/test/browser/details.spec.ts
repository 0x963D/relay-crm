import { test, expect } from "@playwright/test";
import { rpc, signIn } from "./support.ts";
import { browserState } from "./paths.ts";

test("unselected pool prompts selection without an empty assignment count", async ({ page }) => {
  await signIn(page, "manager");
  await expect(page.getByRole("heading", { name: "Assign 0 leads", exact: true })).toHaveCount(0);
});

test("missing payment documents return 404", async ({ page }) => {
  await signIn(page, "accountant");
  for (const path of [
    "/payments/not_an_id",
    "/payments/00000000-0000-7000-8000-000000000000",
    "/payments/00000000-0000-7000-8000-000000000000/edit",
  ]) {
    const response = await page.request.get(`${browserState().url}${path}`);
    expect.soft(response.status(), path).toBe(404);
  }
});

test("payment details state suppression once and explain each decision requirement", async ({
  page,
}) => {
  await signIn(page, "accountant");
  const payments = await rpc(page).payments.list.query({ limit: 100 });
  const account = (await rpc(page).accounts.list.query({ limit: 100 })).items.find(
    (row) => row.person?.name === "Leila Farouk",
  );
  if (!account) throw new Error("Missing suppressed account");
  const ledger = await rpc(page).accounts.ledger.query({ id: account.id });
  const records = await Promise.all(
    ledger.balances
      .flatMap((balance) => balance.entries)
      .map((entry) => rpc(page).payments.get.query({ id: entry.paymentId })),
  );
  const suppressed = records.find((row) => row.receipt?.state === "suppressed");
  const waiting = payments.waitingForProvider[0];
  const approval = payments.waitingForApproval.find((row) => row.actions.approve);
  if (!suppressed || !waiting || !approval) throw new Error("Missing payment details");
  await page.goto(`${browserState().url}/payments/${suppressed.id}`);
  const receipt = page.getByRole("region", { name: "Receipt", exact: true });
  await expect(receipt.getByText("Not sent", { exact: true })).toHaveCount(1);
  await expect(receipt).toContainText("Invented demo suppression");
  await page.goto(`${browserState().url}/payments/${waiting.id}`);
  const terms = await page
    .getByRole("article", { name: "Payment detail" })
    .locator("dt")
    .allTextContents();
  expect(terms.indexOf("First check")).toBeLessThan(terms.indexOf("Next check"));
  await page.goto(`${browserState().url}/payments/${approval.id}`);
  await expect(page.getByRole("button", { name: /^Approve as/ })).toBeEnabled();
  await expect(
    page.getByRole("textbox", { name: "Reason", exact: true }),
  ).toHaveAccessibleDescription("Required to reject or cancel. Approval does not need a reason.");
});
