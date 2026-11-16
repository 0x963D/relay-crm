import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { accessibility, tabTo, latestCode, rpc, saveAttempt, signIn } from "./support.ts";
import { browserState } from "./paths.ts";
const leadName = "Browser Journey";
test.describe.serial("lead work journeys", () => {
  test("a public enquiry is assigned by a manager and reaches the agent queue", async ({
    page,
  }) => {
    const response = await page.request.post(`${browserState().url}/api/intake/form`, {
      data: {
        submissionId: randomUUID(),
        name: leadName,
        email: "browser.journey@example.com",
        phone: "+44 7700 900999",
        campaign: "Evening course",
        form: "Course enquiry",
      },
    });
    expect(response.status()).toBe(202);
    await signIn(page, "manager");
    await expect(page.getByRole("heading", { name: "Lead pool", exact: true })).toBeVisible();
    await accessibility(page, "pool-hand");
    await page.getByRole("checkbox", { name: `Select ${leadName}`, exact: true }).check();
    await page.getByRole("radio", { name: /Dele Akinwale/ }).check();
    await page.getByRole("button", { name: "Assign 1 lead to Dele Akinwale", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "1 lead was assigned" })).toBeVisible();
    await page
      .getByRole("radiogroup", { name: "View the demo as" })
      .getByRole("radio", { name: "Agent", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "My queue", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: `Open ${leadName}`, exact: true })).toBeVisible();
    await accessibility(page, "queue-light");
  });
  test("an agent records attempts, moves and clears a callback, adds a note and wins an account", async ({
    page,
  }) => {
    await signIn(page, "agent");
    const beforeQueue = await rpc(page).leads.queue.query({});
    const beforeTotal = Object.values(beforeQueue.counts).reduce((a, b) => a + b, 0);
    await page.getByRole("link", { name: `Open ${leadName}`, exact: true }).click();
    await saveAttempt(page, "No answer", "Rang out. Will try tomorrow.");
    await expect(page.getByRole("region", { name: "Lead detail", exact: true })).toContainText(
      "Not contacted",
    );
    await page.getByRole("button", { name: "Set callback", exact: true }).click();
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await page.getByLabel("Day", { exact: true }).fill(tomorrow);
    await page.getByLabel("Time", { exact: true }).fill("09:30");
    await accessibility(page, "callback-set");
    await page.getByRole("button", { name: "Save callback", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Callback saved" })).toBeVisible();
    await page.getByRole("button", { name: "Move callback", exact: true }).click();
    await page.getByLabel("Day", { exact: true }).fill(tomorrow);
    await page.getByLabel("Time", { exact: true }).fill("10:30");
    await page.getByRole("button", { name: "Save callback", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Callback saved" })).toBeVisible();
    await page.getByRole("button", { name: "Move callback", exact: true }).click();
    await page.getByRole("button", { name: "Clear callback", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Callback cleared" })).toBeVisible();
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Note", exact: true })
      .fill("Customer asked for the Tuesday course.");
    await accessibility(page, "note");
    await page.getByRole("button", { name: "Save note", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Note added" })).toBeVisible();
    await saveAttempt(page, "Spoke to them", "Confirmed the Tuesday course and price.");
    await page.getByRole("button", { name: "Close lead", exact: true }).click();
    await page.getByRole("tab", { name: "Won", exact: true }).click();
    await accessibility(page, "close-won");
    await page.getByRole("button", { name: "Close as won", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "An account was opened" }),
    ).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "An account was opened" }),
    ).toBeFocused();
    const accounts = await rpc(page).accounts.list.query({ limit: 100 });
    expect(accounts.items.some((a) => a.person?.name === leadName)).toBe(true);
    const queue = await rpc(page).leads.queue.query({});
    expect(Object.values(queue.counts).reduce((a, b) => a + b, 0)).toBe(beforeTotal - 1);
    await accessibility(page, "lead-won");
  });
});
test("emailed-code sign-in and a refused reused code", async ({ page }) => {
  await page.goto(browserState().url);
  await accessibility(page, "sign-in-email");
  await page
    .getByRole("textbox", { name: "Work email", exact: true })
    .fill("priya.raman@tidewell.example");
  await page.getByRole("button", { name: "Send me a code", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
  await accessibility(page, "sign-in-code");
  await expect.poll(latestCode).toMatch(/^\d{6}$/);
  const code = await latestCode();
  await page.getByRole("textbox", { name: "6-digit code", exact: true }).fill(code);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Lead pool", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).first().click();
  await page
    .getByRole("textbox", { name: "Work email", exact: true })
    .fill("priya.raman@tidewell.example");
  await page.getByRole("button", { name: "Send me a code", exact: true }).click();
  await page.getByRole("textbox", { name: "6-digit code", exact: true }).fill(code);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toContainText(
    "That code did not work",
  );
  await accessibility(page, "code-refused");
});
test("queue stays usable in dark, phone, keyboard and reduced-motion views", async ({ page }) => {
  await signIn(page, "agent");
  await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption("dark");
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  await accessibility(page, "queue-dark");
  await page.setViewportSize({ width: 390, height: 844 });
  await accessibility(page, "queue-phone-dark");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const title of [
    "Overdue callbacks",
    "Due today",
    "No callback set",
    "Assigned to you, not yet called",
    "Later",
  ])
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeAttached();
  await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption("light");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await accessibility(page, "queue-phone-light");
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.matches(":focus-visible"))).toBe(true);
  const call = page.getByRole("link", { name: "Call Hye-jin Park", exact: true });
  await call.scrollIntoViewIfNeeded();
  await tabTo(page, call);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Log an attempt", exact: true })).toBeVisible();
  await accessibility(page, "attempt-phone");
});
