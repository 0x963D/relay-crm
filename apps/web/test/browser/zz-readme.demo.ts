import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { signIn, rpc, saveAttempt } from "./support.ts";
import { browserState, captureDirectory } from "./paths.ts";

test("README journeys work through the browser with scheduled recovery", async ({ page }) => {
  test.setTimeout(180000);
  await mkdir(captureDirectory, { recursive: true });
  await signIn(page, "accountant");
  const api = rpc(page);
  const payments = await api.payments.list.query({ limit: 100 });
  const late = payments.needsReview.find(
    (payment) =>
      payment.state.status === "needsReview" && payment.state.reason === "paid after close",
  );
  const waiting = payments.waitingForProvider.find(
    (payment) => payment.account?.name === "Marek Novak",
  );
  const account = (await api.accounts.list.query({ limit: 100 })).items.find(
    (row) => row.person?.name === "Jonas Weber",
  );
  if (!late || !waiting || !account) throw new Error("Missing seeded payment stories.");
  const ledger = await api.accounts.ledger.query({ id: account.id });
  const recovered = ledger.balances
    .flatMap((balance) => balance.entries)
    .find((entry) => entry.completion.by === "reconciler");
  if (!recovered) throw new Error("Missing seeded reconciler payment.");
  for (const [name, id] of [
    ["paid-after-close", late.id],
    ["waiting", waiting.id],
    ["reconciled", recovered.paymentId],
  ] as const) {
    await page.goto(`${browserState().url}/payments/${id}`);
    const events = page.getByRole("list", { name: "Payment events" });
    await expect(events.getByRole("heading").first()).toHaveText("Checkout created");
    if (name === "paid-after-close") {
      await expect(events.getByRole("heading")).toHaveText([
        "Checkout created",
        "The reconciler asked the provider",
        "Payment closed as expired",
        "The webhook arrived late",
        "Moved to needs review",
      ]);
      await expect(page.getByRole("region", { name: "Review comparison" })).toContainText(
        "The amount and the currency match.",
      );
    } else if (name === "waiting") {
      await expect(events).not.toContainText("No webhook was recorded");
      await expect(events.getByRole("heading").last()).toContainText("checks changed nothing");
    } else {
      await expect(events.getByRole("heading")).toHaveText([
        "Checkout created",
        "No webhook was recorded before this check",
        "The reconciler asked the provider",
        "The payment was completed",
        "The webhook arrived late",
      ]);
    }
    await page.screenshot({ path: join(captureDirectory, `${name}.png`), fullPage: true });
  }
  await page.getByRole("radio", { name: "Manager", exact: true }).click();
  await page
    .getByRole("checkbox", { name: /^Select / })
    .nth(1)
    .check();
  await page
    .getByRole("checkbox", { name: /^Select / })
    .nth(2)
    .check();
  await page.getByRole("tab", { name: "Round-robin", exact: true }).click();
  await page.getByRole("button", { name: "Preview 2 leads", exact: true }).click();
  await expect(page.getByRole("region", { name: "Assignment preview", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Assign 2 leads", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "2 leads were assigned" })).toBeVisible();
  await page.getByRole("radio", { name: "Agent", exact: true }).click();
  await page.getByRole("link", { name: "Open Hye-jin Park", exact: true }).click();
  await saveAttempt(page, "Spoke to them", "Confirmed the evening class and price.");
  await page.getByRole("button", { name: "Close lead", exact: true }).click();
  await page.getByRole("radio", { name: "Won", exact: true }).click();
  await page.getByRole("button", { name: "Close as won", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "An account was opened" })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Accounts", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Accounts", exact: true })
    .getByRole("link")
    .filter({ hasText: "Leila Farouk" })
    .click();
  await page.getByRole("link", { name: "Create card checkout", exact: true }).click();
  await page.getByRole("textbox", { name: "Amount", exact: true }).fill("395.00");
  await page.getByRole("button", { name: "Create checkout", exact: true }).click();
  const popup = page.context().waitForEvent("page");
  await page.getByRole("link", { name: "Open the page", exact: true }).click();
  const sandbox = await popup;
  await sandbox.getByRole("radio", { name: /^Drop it/ }).check();
  await sandbox.getByRole("button", { name: "Pay £395.00", exact: true }).click();
  await sandbox.getByRole("link", { name: "go back to Relay CRM", exact: true }).click();
  await expect(sandbox.getByRole("heading", { name: "Credited once", exact: true })).toBeVisible({
    timeout: 75000,
  });
  await expect(
    sandbox
      .getByRole("article", { name: "Payment detail" })
      .getByText("The reconciler", { exact: true }),
  ).toBeVisible();
  await expect(sandbox.getByRole("region", { name: "Payment outcome" })).toContainText(
    "1ledger posting",
  );
  const id = sandbox.url().split("/").at(-1);
  if (!id) throw new Error("Missing payment route.");
  expect((await rpc(sandbox).payments.get.query({ id })).postingCount).toBe(1);
  await sandbox.screenshot({ path: join(captureDirectory, "readme-recovery.png"), fullPage: true });
  await sandbox.close();
});
