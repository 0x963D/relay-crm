import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { browserDirectory, browserState } from "./paths.ts";
import { rpc, signIn, accessibility, tabTo } from "./support.ts";

async function enquiry(page: Page, name: string) {
  const response = await page.request.post(`${browserState().url}/api/intake/form`, {
    data: {
      submissionId: randomUUID(),
      name,
      email: `${randomUUID()}@example.com`,
      phone: "+44 7700 900991",
    },
  });
  expect(response.status()).toBe(202);
}
async function announcement(page: Page, role: "status" | "alert", text: string, name: string) {
  const region = page.getByRole(role).filter({ hasText: text });
  await expect(region).toBeVisible();
  const session = await page.context().newCDPSession(page);
  const tree = await session.send("Accessibility.getFullAXTree");
  await session.detach();
  const live = tree.nodes.filter(
    (node) =>
      node.role?.value === role &&
      node.properties?.some(
        (property) =>
          property.name === "live" &&
          property.value.value === (role === "status" ? "polite" : "assertive"),
      ),
  );
  expect(live.length).toBeGreaterThan(0);
  expect(await region.ariaSnapshot()).toContain(text);
  await mkdir(browserDirectory, { recursive: true });
  await writeFile(
    join(browserDirectory, `announcement-${name}.json`),
    JSON.stringify({ live, snapshot: await region.ariaSnapshot() }, null, 2),
  );
}

test("keyboard assignment and attempt preserve focus and drafts", async ({ page }) => {
  await enquiry(page, "Keyboard Journey");
  await page.goto(browserState().url);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Work email")).toBeFocused();
  await tabTo(page, page.getByRole("button", { name: "Priya Raman Manager", exact: true }));
  await page.keyboard.press("Enter");
  const select = page.getByRole("checkbox", { name: "Select Keyboard Journey", exact: true });
  await tabTo(page, select);
  await page.keyboard.press("Space");
  const recipient = page.getByRole("radio", { name: /Dele Akinwale/ });
  await tabTo(
    page,
    page.getByRole("radiogroup", { name: "Who gets them?" }).getByRole("radio", { checked: true }),
  );
  await page.keyboard.press("ArrowDown");
  await expect(recipient).toBeFocused();
  await page.keyboard.press("Space");
  await tabTo(
    page,
    page.getByRole("button", { name: "Assign 1 lead to Dele Akinwale", exact: true }),
  );
  await page.keyboard.press("Enter");
  const status = page.getByRole("status");
  await expect(status).toHaveText(/1 lead was assigned/);
  await expect(status).toBeFocused();
  await announcement(page, "status", "1 lead was assigned", "assignment");
  const manager = page.getByRole("radio", { name: "Manager", exact: true });
  await tabTo(page, manager);
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Agent", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "My queue", exact: true })).toBeVisible();
  const lead = page
    .getByRole("button")
    .filter({ has: page.getByText("Keyboard Journey", { exact: true }) });
  await tabTo(page, lead);
  await page.keyboard.press("Enter");
  const open = page.getByRole("button", { name: "Log an attempt", exact: true });
  await tabTo(page, open);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("radio", { name: "Call", exact: true })).toBeFocused();
  const note = page.getByLabel("Note", { exact: true });
  await tabTo(page, note);
  await page.keyboard.type("No answer. Try after work.");
  await page.keyboard.press("Escape");
  await expect(open).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(note).toHaveValue("No answer. Try after work.");
  await tabTo(page, page.getByRole("button", { name: "Save attempt", exact: true }));
  await page.keyboard.press("Enter");
  await expect(open).toBeFocused();
  await announcement(page, "status", "No-answer attempt saved", "attempt");
});

test("attempts move between queue groups and only a conversation marks contacted", async ({
  page,
}) => {
  await enquiry(page, "Queue Moves");
  await signIn(page, "manager");
  const api = rpc(page);
  const pool = await api.leads.pool.query({ limit: 100 });
  const lead = pool.rows.find((row) => row.name === "Queue Moves");
  const agent = (await api.leads.agents.query({})).find(
    (person) => person.name === "Dele Akinwale",
  );
  if (!lead || !agent) throw new Error("Missing fixture");
  await api.leads.assign.mutate({
    leadIds: [lead.id],
    to: { ownerId: agent.ownerId, teamId: agent.teamId },
  });
  await page.getByRole("radio", { name: "Agent", exact: true }).click();
  const row = () =>
    page.getByRole("button").filter({ has: page.getByText("Queue Moves", { exact: true }) });
  await expect(page.locator("section[aria-labelledby=group-notYetCalled]")).toContainText(
    "Queue Moves",
  );
  await row().click();
  await expect(page.locator(".lead-contact")).toContainText("Not contacted");
  await page.getByRole("button", { name: "Log an attempt", exact: true }).click();
  await page.getByLabel("Note", { exact: true }).fill("Rang out.");
  await page.getByRole("button", { name: "Save attempt", exact: true }).click();
  await expect(page.locator("section[aria-labelledby=group-noCallbackSet]")).toContainText(
    "Queue Moves",
  );
  await expect(page.locator(".lead-contact")).toContainText("Not contacted");
  await page.getByRole("button", { name: "Log an attempt", exact: true }).click();
  await page.getByRole("radio", { name: /^Spoke to them/ }).check();
  await page.getByLabel("Note", { exact: true }).fill("Discussed the course.");
  await page.getByLabel("Call back", { exact: true }).check();
  await page
    .getByLabel("Day", { exact: true })
    .fill(new Date(Date.now() + 86400000).toISOString().slice(0, 10));
  await page.getByLabel("Time", { exact: true }).fill("17:30");
  await page.getByRole("button", { name: "Save attempt", exact: true }).click();
  await expect(page.locator("section[aria-labelledby=group-later]")).toContainText("Queue Moves");
  await page.getByRole("button", { name: "Move callback", exact: true }).click();
  await page.getByRole("button", { name: "Clear callback", exact: true }).click();
  await expect(page.locator(".lead-contact")).toContainText("Contacted");
  expect((await api.leads.get.query({ id: lead.id })).contactedAt).not.toBeNull();
});

test("round-robin assigns exactly the preview and announces a stale refusal", async ({ page }) => {
  for (const name of ["Round First", "Round Second", "Round Stale"]) await enquiry(page, name);
  await signIn(page, "manager");
  await page.getByRole("tab", { name: "Round-robin", exact: true }).click();
  for (const name of ["Round First", "Round Second"])
    await page.getByRole("checkbox", { name: `Select ${name}`, exact: true }).check();
  await page.getByRole("button", { name: "Preview 2 leads", exact: true }).click();
  await expect(page.getByText("Not assigned yet", { exact: true })).toBeVisible();
  const api = rpc(page);
  const rows = (await api.leads.pool.query({ limit: 100 })).rows.filter((row) =>
    ["Round First", "Round Second"].includes(row.name ?? ""),
  );
  await page.getByRole("button", { name: "Assign 2 leads", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("2 leads were assigned");
  const owners = await Promise.all(
    rows.map(async (row) => (await api.leads.get.query({ id: row.id })).custody.heldBy?.id),
  );
  expect(owners.every(Boolean)).toBe(true);
  expect(new Set(owners).size).toBe(rows.length);
  await page.getByRole("checkbox", { name: "Select Round Stale", exact: true }).check();
  await page.getByRole("button", { name: "Preview 1 lead", exact: true }).click();
  const stale = (await api.leads.pool.query({ limit: 100 })).rows.find(
    (row) => row.name === "Round Stale",
  );
  const agent = (await api.leads.agents.query({}))[0];
  if (!stale || !agent) throw new Error("Missing fixture");
  await api.leads.assign.mutate({
    leadIds: [stale.id],
    to: { ownerId: agent.ownerId, teamId: agent.teamId },
  });
  await page.getByRole("button", { name: "Assign 1 lead", exact: true }).click();
  await announcement(page, "alert", "Nothing was assigned", "stale");
  await expect(page.getByRole("alert").filter({ hasText: "Nothing was assigned" })).toContainText(
    "No selected leads remain in the pool",
  );
  await expect(page.getByRole("button", { name: /Preview the remaining 0/ })).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: "Nothing was assigned" })).toBeFocused();
  await expect(page.locator("[data-stale=true]")).toHaveCSS("opacity", "0.85");
  await accessibility(page, "stale-foundation");
});

test("system dark works without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto(browserState().signInUrl);
  await expect(page.locator(".sign-sheet")).toHaveCSS("background-color", "rgb(21, 24, 64)");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Work email")).toBeFocused();
  await page.screenshot({ path: join(browserDirectory, "nojs-dark.png") });
  await context.close();
});

test("server hydration and cached navigation avoid repeated reads", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/trpc/") || request.headers().rsc === "1")
      requests.push(request.url());
  });
  await signIn(page, "agent");
  await expect(page.getByRole("heading", { name: "Hye-jin Park", exact: true })).toBeVisible();
  expect(requests).toEqual([]);
  const html = await page.request.get(browserState().url);
  expect(await html.text()).toMatch(/<h2>Hye-jin Park<\/h2>/);
  const row = (name: string) =>
    page.getByRole("button").filter({ has: page.getByText(name, { exact: true }) });
  await row("Hye-jin Park").click();
  await expect(page).toHaveURL(/lead=/);
  expect(requests).toEqual([]);
  await row("Mateus Carvalho").click();
  await expect(page.getByRole("heading", { name: "Mateus Carvalho", exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("leads.get");
  await row("Hye-jin Park").click();
  await expect(page.getByRole("heading", { name: "Hye-jin Park", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Mateus Carvalho", exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
});
