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
  await expect(page.getByRole("textbox", { name: "Work email", exact: true })).toBeFocused();
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
  await expect(recipient).toBeChecked();
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
  const lead = page.getByRole("link", { name: `Open Keyboard Journey`, exact: true });
  await tabTo(page, lead);
  await page.keyboard.press("Enter");
  const open = page.getByRole("button", { name: "Log an attempt", exact: true });
  await tabTo(page, open);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("radio", { name: "Call", exact: true })).toBeFocused();
  const note = page.getByRole("textbox", { name: "Note", exact: true });
  await tabTo(page, note);
  await page.keyboard.type("No answer. Try after work.");
  await page.keyboard.press("Escape");
  await expect(open).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(note).toHaveValue("No answer. Try after work.");
  await tabTo(page, page.getByRole("button", { name: "Save attempt", exact: true }));
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "No-answer attempt saved" }),
  ).toBeFocused();
  await announcement(page, "status", "No-answer attempt saved", "attempt");
  await tabTo(page, page.getByRole("button", { name: "Set callback", exact: true }));
  await page.keyboard.press("Enter");
  const day = page.getByLabel("Day", { exact: true });
  await tabTo(page, day);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await page.keyboard.type(
    `${tomorrow.slice(5, 7)}${tomorrow.slice(8, 10)}${tomorrow.slice(0, 4)}`,
  );
  await expect(day).toHaveValue(tomorrow);
  const time = page.getByLabel("Time", { exact: true });
  await tabTo(page, time);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("0930");
  await page.keyboard.press("a");
  await expect(time).toHaveValue("09:30");
  await tabTo(page, page.getByRole("button", { name: "Save callback", exact: true }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Callback saved" })).toBeFocused();
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
  const row = () => page.getByRole("link", { name: `Open Queue Moves`, exact: true });
  await expect(
    page.getByRole("region", { name: "Assigned to you, not yet called", exact: true }),
  ).toContainText("Queue Moves");
  await row().click();
  await expect(page.getByRole("region", { name: "Lead detail", exact: true })).toContainText(
    "Not contacted",
  );
  await page.getByRole("button", { name: "Log an attempt", exact: true }).click();
  await page.getByRole("textbox", { name: "Note", exact: true }).fill("Rang out.");
  await page.getByRole("button", { name: "Save attempt", exact: true }).click();
  await expect(page.getByRole("region", { name: "No callback set", exact: true })).toContainText(
    "Queue Moves",
  );
  await expect(page.getByRole("region", { name: "Lead detail", exact: true })).toContainText(
    "Not contacted",
  );
  await page.getByRole("button", { name: "Log an attempt", exact: true }).click();
  await page.getByRole("radio", { name: /^Spoke to them/ }).check();
  await page.getByRole("textbox", { name: "Note", exact: true }).fill("Discussed the course.");
  await page.getByRole("checkbox", { name: "Call back", exact: true }).check();
  await page
    .getByLabel("Day", { exact: true })
    .fill(new Date(Date.now() + 86400000).toISOString().slice(0, 10));
  await page.getByLabel("Time", { exact: true }).fill("17:30");
  await page.getByRole("button", { name: "Save attempt", exact: true }).click();
  await expect(page.getByRole("region", { name: "Later", exact: true })).toContainText(
    "Queue Moves",
  );
  await page.getByRole("button", { name: "Move callback", exact: true }).click();
  await page.getByRole("button", { name: "Clear callback", exact: true }).click();
  await expect(page.getByRole("region", { name: "Lead detail", exact: true })).toContainText(
    "Contacted",
  );
  expect((await api.leads.get.query({ id: lead.id })).contactedAt).not.toBeNull();
});

test("round-robin assigns exactly the preview and announces a stale refusal", async ({ page }) => {
  for (const name of ["Round First", "Round Second", "Round Stale", "Round Remaining"])
    await enquiry(page, name);
  await signIn(page, "manager");
  await page.getByRole("tab", { name: "Round-robin", exact: true }).click();
  for (const name of ["Round First", "Round Second"])
    await page.getByRole("checkbox", { name: `Select ${name}`, exact: true }).check();
  await page.getByRole("button", { name: "Preview 2 leads", exact: true }).click();
  await expect(page.getByRole("region", { name: "Assignment preview", exact: true })).toContainText(
    "Not assigned yet",
  );
  const api = rpc(page);
  const rows = (await api.leads.pool.query({ limit: 100 })).rows.filter((row) =>
    ["Round First", "Round Second"].includes(row.name ?? ""),
  );
  const agents = await api.leads.agents.query({});
  const expected = await Promise.all(
    rows.map(async (row) => {
      const cells = page
        .getByRole("row")
        .filter({
          has: page.getByRole("checkbox", { name: `Select ${row.name ?? row.email}`, exact: true }),
        })
        .getByRole("cell");
      const [name, team] = (await cells.last().innerText()).split("\n");
      const candidates = agents.filter(
        (agent) => agent.name === name && (!team || agent.team === team),
      );
      expect(candidates, `Unambiguous preview owner for ${row.name ?? row.email}`).toHaveLength(1);
      const owner = candidates[0];
      expect(owner, `Preview owner for ${row.name ?? row.email}`).toBeDefined();
      return { id: row.id, owner };
    }),
  );
  await expect(page.getByRole("heading", { name: "Preview", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Assign 2 leads", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("2 leads were assigned");
  for (const item of expected) {
    const actual = await api.leads.get.query({ id: item.id });
    expect(actual.custody.heldBy?.id).toBe(item.owner?.ownerId);
    expect(actual.lifecycle.state).toMatchObject({ assignee: { teamId: item.owner?.teamId } });
  }
  await page.getByRole("checkbox", { name: "Select Round Stale", exact: true }).check();
  await page.getByRole("checkbox", { name: "Select Round Remaining", exact: true }).check();
  await page.getByRole("button", { name: "Preview 2 leads", exact: true }).click();
  await expect(page.getByRole("region", { name: "Assignment preview", exact: true })).toContainText(
    "Not assigned yet",
  );
  const stale = (await api.leads.pool.query({ limit: 100 })).rows.find(
    (row) => row.name === "Round Stale",
  );
  const agent = (await api.leads.agents.query({}))[0];
  if (!stale || !agent) throw new Error("Missing fixture");
  await api.leads.assign.mutate({
    leadIds: [stale.id],
    to: { ownerId: agent.ownerId, teamId: agent.teamId },
  });
  await page.getByRole("button", { name: "Assign 2 leads", exact: true }).click();
  const repreview = page.getByRole("button", { name: "Preview the remaining 1 lead", exact: true });
  await expect(repreview).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Assignment preview", exact: true })).toContainText(
    "Not assigned yet",
  );
  const remaining = (await api.leads.pool.query({ limit: 100 })).rows.find(
    (row) => row.name === "Round Remaining",
  );
  if (!remaining) throw new Error("Missing remaining lead");
  await api.leads.assign.mutate({
    leadIds: [remaining.id],
    to: { ownerId: agent.ownerId, teamId: agent.teamId },
  });
  await page.getByRole("button", { name: "Assign 1 lead", exact: true }).click();
  await announcement(page, "alert", "Nothing was assigned", "stale");
  await expect(page.getByRole("alert").filter({ hasText: "Nothing was assigned" })).toContainText(
    "No selected leads remain in the pool",
  );
  await expect(page.getByRole("button", { name: /Preview the remaining 0/ })).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: "Nothing was assigned" })).toBeFocused();
  await expect(page.getByRole("region", { name: "Assignment preview", exact: true })).toHaveCSS(
    "opacity",
    "0.9",
  );
  await accessibility(page, "stale-foundation");
});

test("system dark works without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto(browserState().signInUrl);
  await expect(page.getByRole("main")).toHaveCSS("background-color", "rgb(21, 24, 64)");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("textbox", { name: "Work email", exact: true })).toBeFocused();
  await page.screenshot({ path: join(browserDirectory, "nojs-dark.png") });
  await context.close();
});

test("route navigation preserves the queue, reloads and goes back", async ({ page }) => {
  await signIn(page, "agent");
  const queue = page.getByRole("region", { name: "Work queue", exact: true });
  await queue.evaluate((element) => {
    element.setAttribute("data-mounted-proof", "original");
  });
  await page.getByRole("link", { name: "Open Hye-jin Park", exact: true }).click();
  await expect(page).toHaveURL(/\/queue\/leads\//);
  const url = page.url();
  await expect(page.getByRole("heading", { name: "Hye-jin Park", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Open Mateus Carvalho", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Mateus Carvalho", exact: true })).toBeVisible();
  await expect(queue).toHaveAttribute("data-mounted-proof", "original");
  await page.goBack();
  await expect(page).toHaveURL(url);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Hye-jin Park", exact: true })).toBeVisible();
});

test("tabs render enabled and respond after hydration", async ({ page }) => {
  const url = browserState().url;
  const response = await page.request.post(`${url}/api/auth/demo`, {
    headers: { origin: url },
    data: { role: "manager" },
  });
  expect(response.status()).toBe(200);
  let release: () => void = () => undefined;
  const scripts = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/_next\/static\/.*\.js/, async (route) => {
    await scripts;
    await route.continue();
  });
  try {
    await page.goto(url, { waitUntil: "commit" });
    const tab = page.getByRole("tab", { name: "Round-robin", exact: true });
    await expect(tab).toBeVisible();
    await expect(tab).toBeEnabled();
    release();
    await page.waitForLoadState("load");
    await expect(tab).toBeEnabled();
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  } finally {
    release();
  }
});
