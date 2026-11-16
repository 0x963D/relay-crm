import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { rpc, signIn } from "./support.ts";
import { browserState } from "./paths.ts";

test("paging keeps the queue, draft and focus through loading and failure", async ({ page }) => {
  for (let index = 0; index < 25; index++) {
    const response = await page.request.post(`${browserState().url}/api/intake/form`, {
      headers: { "x-forwarded-for": `192.0.2.${String(index + 1)}` },
      data: {
        submissionId: randomUUID(),
        name: `Paging ${String(index)}`,
        email: `${randomUUID()}@example.com`,
      },
    });
    expect(response.status()).toBe(202);
  }
  await signIn(page, "manager");
  const api = rpc(page);
  const agent = (await api.leads.agents.query({})).find((row) => row.name === "Dele Akinwale");
  if (!agent) throw new Error("Missing agent");
  await api.leads.assign.mutate({
    leadIds: (await api.leads.pool.query({ limit: 100 })).rows
      .filter((row) => row.name?.startsWith("Paging "))
      .map((row) => row.id),
    to: { ownerId: agent.ownerId, teamId: agent.teamId },
  });
  await page.getByRole("radio", { name: "Agent", exact: true }).click();
  await page.getByRole("link", { name: "Open Hye-jin Park", exact: true }).click();
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "Note", exact: true });
  await draft.fill("Keep this draft while paging.");
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/api\/trpc\/leads.queue/, async (route) => {
    await gate;
    await route.abort();
  });
  const more = page.getByRole("button", { name: "Show more leads", exact: true });
  try {
    await more.click();
    await expect(page.getByRole("heading", { name: "My queue", exact: true })).toBeVisible();
    await expect(draft).toHaveValue("Keep this draft while paging.");
    await expect(more).toBeFocused();
    release();
    await expect(page.getByRole("alert").filter({ hasText: "could not be reached" })).toBeVisible();
    await expect(draft).toHaveValue("Keep this draft while paging.");
    await page.unroute(/api\/trpc\/leads.queue/);
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByRole("link", { name: /^Open Paging / })).toHaveCount(25);
    await expect(draft).toHaveValue("Keep this draft while paging.");
  } finally {
    release();
  }
});

test("paging the pool keeps its selection and focus", async ({ page }) => {
  await signIn(page, "manager");
  const first = page.getByRole("checkbox", { name: /^Select / }).nth(1);
  await first.check();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/api\/trpc\/leads.pool/, async (route) => {
    await gate;
    await route.continue();
  });
  const more = page.getByRole("button", { name: "Show more leads", exact: true });
  try {
    await more.click();
    await expect(first).toBeChecked();
    await expect(more).toBeFocused();
    release();
    await expect(page.getByRole("button", { name: "All leads shown", exact: true })).toBeFocused();
    await expect(first).toBeChecked();
  } finally {
    release();
  }
});
