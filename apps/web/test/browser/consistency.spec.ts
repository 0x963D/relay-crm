import { test, expect } from "@playwright/test";
import { signIn, latestCode } from "./support.ts";
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
  await page.getByRole("link", { name: "Create card checkout", exact: true }).click();
  await page.getByRole("textbox", { name: "Amount", exact: true }).fill("395.00");
  await page.getByRole("button", { name: "Create checkout", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Pay link", exact: true })).toBeVisible();
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
