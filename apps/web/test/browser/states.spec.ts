import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { accessibility, rpc, signIn } from "./support.ts";
import { browserState } from "./paths.ts";
test("WhatsApp attempts, lost reasons and wrong-number refusals use the real commands", async ({
  page,
}) => {
  for (const name of ["Lost Journey", "Dead Journey"]) {
    const response = await page.request.post(`${browserState().url}/api/intake/form`, {
      data: {
        submissionId: randomUUID(),
        email: `${name.toLowerCase().replace(" ", ".")}@example.com`,
        name,
        phone: "+44 7700 900998",
      },
    });
    expect(response.status()).toBe(202);
  }
  await signIn(page, "manager");
  for (const name of ["Lost Journey", "Dead Journey"])
    await page.getByRole("checkbox", { name: `Select ${name}`, exact: true }).check();
  await page.getByRole("radio", { name: /Dele Akinwale/ }).check();
  await page.getByRole("button", { name: "Assign 2 leads to Dele Akinwale", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "2 leads were assigned" })).toBeVisible();
  await page.getByRole("link", { name: "Agent queues", exact: true }).click();
  await page.getByLabel("View agent queue").selectOption({ label: "Dele Akinwale" });
  await expect(
    page.getByRole("heading", { name: "Dele Akinwale's queue", exact: true }),
  ).toBeVisible();
  await accessibility(page, "manager-agent-queue");
  await page
    .getByRole("radiogroup", { name: "View the demo as" })
    .getByRole("radio", { name: "Agent", exact: true })
    .click();
  await page
    .getByRole("button")
    .filter({ has: page.getByText("Lost Journey", { exact: true }) })
    .click();
  await page.getByRole("button", { name: "WhatsApp", exact: true }).click();
  await page.getByLabel("Note", { exact: true }).fill("No reply to the course dates.");
  await page.getByRole("button", { name: "Save attempt", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "does not mark the lead as contacted" }),
  ).toBeVisible();
  await expect(page.getByLabel("Lead detail")).toContainText("WhatsApp attempt");
  await page.getByRole("button", { name: "Close lead", exact: true }).click();
  await page.getByLabel("Why was it lost?", { exact: true }).fill("Chose a school closer to home.");
  await page.getByRole("button", { name: "Close as lost", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Lead closed as lost" })).toBeVisible();
  await page
    .getByRole("button")
    .filter({ has: page.getByText("Dead Journey", { exact: true }) })
    .click();
  await page.getByRole("button", { name: "Close lead", exact: true }).click();
  await page.getByRole("tab", { name: "Dead", exact: true }).click();
  await page.getByRole("combobox", { name: /Why is this lead dead/ }).selectOption("wrongNumber");
  await page.getByRole("button", { name: "Close as dead", exact: true }).click();
  await expect(page.locator("[data-slot=alert]")).toContainText(
    "Try contacting this lead in its current assignment",
  );
  await accessibility(page, "wrong-number-refused");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "WhatsApp", exact: true }).click();
  await page.getByLabel("Note", { exact: true }).fill("The number belongs to someone else.");
  await page.getByRole("button", { name: "Save attempt", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "No-answer attempt saved" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close lead", exact: true }).click();
  await page.getByRole("tab", { name: "Dead", exact: true }).click();
  await page.getByRole("combobox", { name: /Why is this lead dead/ }).selectOption("wrongNumber");
  await accessibility(page, "close-dead");
  await page.getByRole("button", { name: "Close as dead", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Lead closed as dead" })).toBeVisible();
});
test("the shell fits the supported desktop and phone viewports", async ({ page }) => {
  await signIn(page, "agent");
  for (const [width, height] of [
    [390, 844],
    [1366, 768],
    [1920, 1080],
    [2752, 1152],
  ]) {
    if (!width || !height) throw new Error("Invalid viewport");
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (width > 600)
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(
        true,
      );
    await expect(page.getByRole("heading", { name: "My queue", exact: true })).toBeVisible();
  }
  const queue = await rpc(page).leads.queue.query({});
  await expect(page.locator(".ph-sub")).toContainText(
    `${String(Object.values(queue.counts).reduce((sum, n) => sum + n, 0))} open leads`,
  );
});
