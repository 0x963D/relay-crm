import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { signIn, rpc, saveAttempt } from "./support.ts";
import { browserState } from "./paths.ts";

test("Ctrl+click opens a bookmarkable lead in a new tab", async ({ page, context }) => {
  await signIn(page, "agent");
  const before = page.url();
  const opened = context.waitForEvent("page");
  await page
    .getByRole("link", { name: "Open Hye-jin Park", exact: true })
    .click({ modifiers: ["Control"] });
  const other = await opened;
  await expect(other.getByRole("heading", { name: "Hye-jin Park", exact: true })).toBeVisible();
  await expect(page).toHaveURL(before);
  await expect(other).toHaveURL(/\/queue\/leads\//);
  await other.reload();
  await expect(other.getByRole("heading", { name: "Hye-jin Park", exact: true })).toBeVisible();
  await other.close();
});

test("a refused save refreshes the record and queue after another tab closes it", async ({
  page,
  context,
}) => {
  await page.request.post(`${browserState().url}/api/intake/form`, {
    data: {
      submissionId: randomUUID(),
      name: "Two Tab Lead",
      email: `${randomUUID()}@example.com`,
      phone: "+44 7700 900997",
    },
  });
  await signIn(page, "manager");
  const api = rpc(page);
  const lead = (await api.leads.pool.query({ limit: 100 })).rows.find(
    (row) => row.name === "Two Tab Lead",
  );
  const agent = (await api.leads.agents.query({})).find(
    (person) => person.name === "Dele Akinwale",
  );
  if (!lead || !agent) throw new Error("Missing two-tab fixture");
  await api.leads.assign.mutate({
    leadIds: [lead.id],
    to: { ownerId: agent.ownerId, teamId: agent.teamId },
  });
  await page.getByRole("radio", { name: "Agent", exact: true }).click();
  await page.getByRole("link", { name: "Open Two Tab Lead", exact: true }).click();
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Note", exact: true })
    .fill("A draft made before the other tab closed this lead.");
  const other = await context.newPage();
  await other.goto(page.url());
  await saveAttempt(other, "No answer", "Tried before closing.");
  await other.getByRole("button", { name: "Close lead", exact: true }).click();
  await other
    .getByRole("textbox", { name: "Why was it lost?", exact: true })
    .fill("Chose a later course.");
  await other.getByRole("button", { name: "Close as lost", exact: true }).click();
  await expect(other.getByRole("status").filter({ hasText: "Lead closed as lost" })).toBeVisible();
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /closed/ })).toBeFocused();
  await expect(page.getByRole("region", { name: "Lead detail", exact: true })).toContainText(
    "Lost",
  );
  await expect(page.getByRole("link", { name: "Open Two Tab Lead", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save note", exact: true })).toHaveCount(0);
  await other.close();
});

test("a phone lead receives focus and the pool assignment stays reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "agent");
  await page.getByRole("link", { name: "Open Hye-jin Park", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Hye-jin Park", exact: true })).toBeFocused();
  await page.getByRole("radio", { name: "Manager", exact: true }).click();
  const checkbox = page.getByRole("checkbox", { name: /^Select / }).nth(1);
  await checkbox.check();
  const assign = page.getByRole("button", { name: "Assign 1 selected lead", exact: true });
  await expect(assign).toBeInViewport();
  await assign.click();
  await expect(page.getByRole("heading", { name: "Assign 1 lead", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: /Assign 1 lead to/ })).toBeInViewport();
});
