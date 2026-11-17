import { test, expect } from "@playwright/test";
import { signIn, latestCode, rpc } from "./support.ts";
import { browserState } from "./paths.ts";

test("workspace hydration stays error-free through demo sign-in, checkout and emailed code", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${page.url()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    console.log(error.message);
    errors.push(`${page.url()}: ${error.message}`);
  });
  await signIn(page, "agent");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Accounts", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Accounts", exact: true })
    .getByRole("link")
    .filter({ hasText: "Leila Farouk" })
    .click();
  const before = await rpc(page).payments.list.query({});
  const paymentCount = Object.values(before.counts).reduce((sum, count) => sum + count, 0);
  await page.getByRole("link", { name: "Create card checkout", exact: true }).click();
  await page.getByRole("textbox", { name: "Amount", exact: true }).fill("395.00");
  await page.getByRole("button", { name: "Create checkout", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Pay link", exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Payments", exact: true })
      .locator("span[aria-hidden]"),
  ).toHaveText(`${paymentCount + 1}`);
  const href = await page
    .getByRole("link", { name: "Go to payment", exact: true })
    .getAttribute("href");
  await page.getByRole("link", { name: "Go to payment", exact: true }).click();
  await expect(page.getByRole("article", { name: "Payment detail" })).toBeVisible();
  // Closing this checkout leaves the shared account available for the payment journeys.
  await page
    .getByRole("textbox", { name: "Reason", exact: true })
    .fill("Finished checking checkout creation.");
  await page.getByRole("button", { name: "Close as failed", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close as failed", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out", exact: true }).first().click();
  await page
    .getByRole("textbox", { name: "Work email", exact: true })
    .fill("priya.raman@tidewell.example");
  await page.getByRole("button", { name: "Send me a code", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
  await expect.poll(latestCode).toMatch(/^\d{6}$/);
  await page.getByRole("textbox", { name: "6-digit code", exact: true }).fill(await latestCode());
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Lead pool", exact: true })).toBeVisible();
  await page.goto(`${browserState().url}${href}`);
  await expect(page.getByRole("article", { name: "Payment detail" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("reconciled payment refreshes its detail, list, header and navigation without a reload", async ({
  page,
}) => {
  await signIn(page, "agent");
  const api = rpc(page);
  const account = (await api.accounts.list.query({ limit: 100 })).items.find(
    (row) => row.person?.name === "Hana Kobayashi",
  );
  if (!account) throw new Error("Missing account");
  await page.goto(`${browserState().url}/payments/new/${account.id}/card`);
  await page.getByRole("textbox", { name: "Amount", exact: true }).fill("80.00");
  await page.getByRole("button", { name: "Create checkout", exact: true }).click();
  const payLink = await page.getByRole("textbox", { name: "Pay link", exact: true }).inputValue();
  const href = await page
    .getByRole("link", { name: "Go to payment", exact: true })
    .getAttribute("href");
  if (!href) throw new Error("Missing payment route");
  await page.getByRole("link", { name: "Go to payment", exact: true }).click();
  const detail = page.getByRole("article", { name: "Payment detail" });
  await expect(detail).toContainText("Waiting for the provider");
  const before = await api.payments.list.query({});
  const sandbox = await page.context().newPage();
  await sandbox.goto(payLink);
  await sandbox.getByRole("radio", { name: /^Drop it/ }).check();
  await sandbox.getByRole("button", { name: "Pay £80.00", exact: true }).click();
  await expect(sandbox.getByRole("status")).toContainText("Paid in the sandbox");
  await sandbox.close();
  await page.bringToFront();
  const navigations: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  const response = await page.request.post(`${browserState().url}/api/payments/reconcile`, {
    headers: {
      authorization: `Bearer ${browserState().reconcileSecret ?? "fake-browser-reconcile-secret-abcdefghijklmnopqrstuvwxyz"}`,
    },
  });
  expect(response.ok()).toBe(true);
  await expect(detail.getByRole("heading", { name: "Credited once", exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(
    page.getByRole("region", { name: "Payments", exact: true }).locator(`a[href="${href}"]`),
  ).toContainText("Completed");
  await expect(
    page
      .getByRole("region", { name: "Waiting for the provider", exact: true })
      .locator(`a[href="${href}"]`),
  ).toHaveCount(0);
  await expect(page.locator("main > header")).toContainText(
    `${before.counts.waitingForProvider - 1} waiting for the provider`,
  );
  const after = await api.payments.list.query({});
  await expect(
    page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Payments", exact: true })
      .locator("span[aria-hidden]"),
  ).toHaveText(`${Object.values(after.counts).reduce((sum, count) => sum + count, 0)}`);
  expect(navigations).toEqual([]);
});
