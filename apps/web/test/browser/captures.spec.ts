import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { signIn, rpc, settleFrame } from "./support.ts";
import { browserState, captureDirectory } from "./paths.ts";

test.use({ deviceScaleFactor: 2 });

async function frameCapture(page: Page) {
  await mkdir(captureDirectory, { recursive: true });
  await page.clock.setFixedTime(new Date());
  return async (name: string) => {
    for (const theme of ["light", "dark"]) {
      await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption(theme);
      await settleFrame(page);
      await page.screenshot({ path: join(captureDirectory, `${name}-${theme}.png`) });
    }
    await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption("light");
  };
}

test("@capture every lead-work screen in both themes", async ({ page }) => {
  const capture = await frameCapture(page);
  await page.goto(browserState().signInUrl);
  await page.getByLabel("Work email").fill("priya.raman@tidewell.example");
  await capture("01-email");
  await page.getByRole("button", { name: "Send me a code", exact: true }).click();
  await page.getByLabel("6-digit code").fill("417");
  await capture("02-code");
  await page.getByLabel("6-digit code").fill("000000");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "You could not sign in" })).toBeVisible();
  await capture("15-code-refused");
  await page.context().clearCookies();
  await signIn(page, "manager");
  await page.getByRole("checkbox", { name: "Select Chiara Russo", exact: true }).check();
  await page.getByRole("checkbox", { name: "Select Marek Dvorak", exact: true }).check();
  await page.getByRole("radio", { name: /Noor Haddad/ }).check();
  await capture("03-pool");
  await page.getByRole("checkbox", { name: "Select Chiara Russo", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "Select Marek Dvorak", exact: true }).uncheck();
  for (const name of [
    "Luca Ferraro",
    "Nadia Rahimi",
    "Wei Chen",
    "Zainab Yusuf",
    "Tunde Bakare",
    "Diego Salazar",
    "Ingrid Solberg",
    "Ravi Menon",
    "Farah Siddiqui",
    "Emil Novak",
    "Oskar Nowak",
    "Thabo Nkosi",
  ])
    await page.getByRole("checkbox", { name: `Select ${name}`, exact: true }).check();
  await page.getByRole("tab", { name: "Round-robin", exact: true }).click();
  await page.getByRole("button", { name: "Preview 12 leads", exact: true }).click();
  await expect(page.getByText("Not assigned yet", { exact: true })).toBeVisible();
  await capture("04-preview");
  const agents = await rpc(page).leads.agents.query({});
  const pool = await rpc(page).leads.pool.query({ limit: 100 });
  const changed = pool.rows.filter((row) =>
    ["Wei Chen", "Zainab Yusuf", "Tunde Bakare"].includes(row.name ?? ""),
  );
  const agent = agents.find((person) => person.name === "Ffion Pryce");
  if (changed.length !== 3 || !agent) throw new Error("Missing fixture");
  await rpc(page).leads.assign.mutate({
    leadIds: changed.map((row) => row.id),
    to: { ownerId: agent.ownerId, teamId: agent.teamId },
  });
  await page.getByRole("button", { name: "Assign 12 leads", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toContainText(
    "Nothing was assigned",
  );
  await capture("05-stale");
  let releaseLead: () => void = () => undefined;
  const pendingLead = new Promise<void>((resolve) => {
    releaseLead = resolve;
  });
  const leadRequests = /\/queue\/leads\//;
  await page.route(leadRequests, async (route) => {
    await pendingLead;
    await route.continue();
  });
  try {
    await page.getByRole("radio", { name: "Agent", exact: true }).click();
    await page.getByRole("link", { name: "Open Hye-jin Park", exact: true }).click();
    await expect(page.getByRole("status", { name: "Loading lead", exact: true })).toBeVisible();
    await capture("15-lead-loading");
  } finally {
    releaseLead();
    await page.unroute(leadRequests);
  }
  await expect(page.getByRole("heading", { name: "Hye-jin Park", exact: true })).toBeVisible();
  await capture("06-queue");
  await capture("16-queue");
  await page.getByRole("button", { name: "Log an attempt", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Note", exact: true })
    .fill("Rang out. Will call after the night shift.");
  await page.getByRole("checkbox", { name: "Call back", exact: true }).check();
  await page
    .getByLabel("Day", { exact: true })
    .fill(new Date(Date.now() + 86400000).toISOString().slice(0, 10));
  await page.getByLabel("Time", { exact: true }).fill("16:30");
  await capture("07-attempt");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Close lead", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Why was it lost?", exact: true })
    .fill("Chose a course closer to home.");
  await capture("08-close");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  for (const width of [1440, 1280, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await capture(`queue-${String(width)}`);
  }
  await page.setViewportSize({ width: 390, height: 1340 });
  await page.goto(`${browserState().url}/queue`);
  await expect(page.getByRole("link", { name: "Open Hye-jin Park", exact: true })).toBeVisible();
  await capture("14-phone");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "Open Hye-jin Park", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Hye-jin Park", exact: true })).toBeVisible();
  await capture("lead-390");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("radio", { name: "Manager", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Lead pool", exact: true })).toBeVisible();
  for (const width of [1440, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await capture(`pool-${String(width)}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const role of ["Manager", "Agent", "Accountant"]) {
    await page.getByRole("radio", { name: role, exact: true }).click();
    await expect(page.getByRole("radio", { name: role, exact: true })).toBeChecked();
    await expect(page.getByRole("main")).not.toContainText("Loading");
    await capture(`13-${role.toLowerCase()}`);
  }
});

test("@capture empty and refused workspaces in both themes", async ({ page }) => {
  const capture = await frameCapture(page);
  await signIn(page, "manager");
  const api = rpc(page);
  const pool = await api.leads.pool.query({ limit: 100 });
  const agents = await api.leads.agents.query({});
  const dele = agents.find((person) => person.name === "Dele Akinwale");
  const receiving = agents.find((person) => person.name === "Ffion Pryce");
  const inaccessible = pool.rows[0];
  if (!dele || !receiving || !inaccessible) throw new Error("Missing fixture");
  await page.goto(`${browserState().url}/agents/00000000-0000-7000-8000-000000000101`);
  await expect(page.getByText("You cannot open this queue", { exact: true }).first()).toBeVisible();
  await capture("15-queue-failed");
  await page.getByRole("radio", { name: "Agent", exact: true }).click();
  await expect(page.getByRole("heading", { name: "My queue", exact: true })).toBeVisible();
  await page.goto(`${browserState().url}/queue/leads/${inaccessible.id}`);
  await expect(page.getByText("You cannot open this lead", { exact: true })).toBeVisible();
  await capture("15-lead-refused");
  await page.goto(`${browserState().url}/queue`);
  await page.getByRole("link", { name: "Open Hye-jin Park", exact: true }).click();
  await page.getByRole("button", { name: "Log an attempt", exact: true }).click();
  await page.getByRole("textbox", { name: "Note", exact: true }).fill("Keep this draft.");
  await page.route(/\/api\/trpc\/.*leads\.logAttempt/, (route) => route.abort("connectionrefused"));
  await page.getByRole("button", { name: "Save attempt", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "This was not saved" })).toBeVisible();
  await capture("15-save-failed");
  await page.unrouteAll();
  const queue = await api.leads.queue.query({ limit: 100 });
  for (const row of [
    queue.overdueCallbacks,
    queue.dueToday,
    queue.noCallbackSet,
    queue.notYetCalled,
    queue.later,
  ].flat()) {
    await api.leads.logAttempt.mutate({
      id: row.id,
      key: crypto.randomUUID(),
      channel: "call",
      outcome: "noAnswer",
      note: "Empty queue fixture.",
    });
    await api.leads.close.mutate({
      id: row.id,
      key: crypto.randomUUID(),
      closing: { kind: "won" },
    });
  }
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "You have no open leads", exact: true }),
  ).toBeVisible();
  await capture("15-queue-empty");
  await page.getByRole("radio", { name: "Manager", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Lead pool", exact: true })).toBeVisible();
  await page.goto(`${browserState().url}/agents/${dele.ownerId}`);
  await expect(
    page.getByRole("heading", { name: "Dele Akinwale has no open leads", exact: true }),
  ).toBeVisible();
  await capture("15-manager-empty");
  await api.leads.assign.mutate({
    leadIds: pool.rows.map((row) => row.id),
    to: { ownerId: receiving.ownerId, teamId: receiving.teamId },
  });
  await page.goto(`${browserState().url}/pool`);
  await expect(page.getByRole("heading", { name: "The pool is empty", exact: true })).toBeVisible();
  await capture("15-pool-empty");
  const role = await page.request.post(`${browserState().url}/api/auth/demo`, {
    headers: { origin: browserState().url },
    data: { role: "accountant" },
  });
  expect(role.status()).toBe(200);
  await page.goto(`${browserState().url}/pool`);
  await expect(
    page.getByText("Accountant screens are not built yet", { exact: true }),
  ).toBeVisible();
  await capture("15-pool-failed");
});
