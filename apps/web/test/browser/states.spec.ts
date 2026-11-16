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
  await page.getByLabel("View agent queue").selectOption({ label: "Dele Akinwale · Sales" });
  await expect(
    page.getByRole("heading", { name: "Dele Akinwale's queue", exact: true }),
  ).toBeVisible();
  await accessibility(page, "manager-agent-queue");
  await page
    .getByRole("radiogroup", { name: "View the demo as" })
    .getByRole("radio", { name: "Agent", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "My queue", exact: true })).toBeVisible();
  await page
    .getByRole("button")
    .filter({ has: page.getByText("Lost Journey", { exact: true }) })
    .click();
  await expect(page.getByRole("heading", { name: "Lost Journey", exact: true })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Dead Journey", exact: true })).toBeVisible();
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
    if (width === 390) {
      await expect(page.locator('.q-select[aria-current="true"]')).toHaveCount(0);
      await expect(page.locator('.qrow[data-auto-selected="true"]')).toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)",
      );
    }
  }
  const queue = await rpc(page).leads.queue.query({});
  await expect(page.locator(".ph-sub")).toContainText(
    `${String(Object.values(queue.counts).reduce((sum, n) => sum + n, 0))} open leads`,
  );
  await page.getByRole("radio", { name: "Manager", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Lead pool", exact: true })).toBeVisible();
  for (const width of [1440, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (width > 600) {
      const heights = await page
        .locator(".pool-list tbody tr")
        .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
      expect(heights.every((height) => height <= 45)).toBe(true);
      await expect(page.getByRole("region", { name: "Assign leads", exact: true })).toBeVisible();
    }
  }
});

test("failed saves keep the draft and distinguish server and connection failures", async ({
  page,
}) => {
  await signIn(page, "agent");
  await page.getByRole("button", { name: "Log an attempt", exact: true }).click();
  await page.getByLabel("Note", { exact: true }).fill("Keep this draft after a refusal.");
  await page.route(/\/api\/trpc\/.*leads\.logAttempt/, (route) => route.abort("connectionrefused"));
  await page.getByRole("button", { name: "Save attempt", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /This was not saved/ })).toContainText(
    "Check your connection",
  );
  await expect(page.getByLabel("Note", { exact: true })).toHaveValue(
    "Keep this draft after a refusal.",
  );
  await page.unrouteAll();
  await page.route(/\/api\/trpc\/.*leads\.logAttempt/, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify([
        {
          error: {
            json: {
              message: "Server failure",
              code: -32603,
              data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
            },
          },
        },
      ]),
    }),
  );
  await page.getByRole("button", { name: "Save attempt", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /This was not saved/ })).toContainText(
    "The server could not complete the request",
  );
  await expect(page.getByRole("alert").filter({ hasText: /This was not saved/ })).not.toContainText(
    "connection",
  );
  await expect(page.getByLabel("Note", { exact: true })).toHaveValue(
    "Keep this draft after a refusal.",
  );
  await page.unrouteAll();
  await page.route(/\/api\/trpc\/.*leads\.logAttempt/, (route) =>
    route.fulfill({ status: 503, contentType: "text/html", body: "Service unavailable" }),
  );
  await page.getByRole("button", { name: "Save attempt", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /This was not saved/ })).toContainText(
    "The server could not complete the request",
  );
  await expect(page.getByRole("alert").filter({ hasText: /This was not saved/ })).not.toContainText(
    "connection",
  );
});

test("a failed paged read keeps the pool and names the failed read", async ({ page }) => {
  await signIn(page, "manager");
  const rows = await page.locator(".pool-list tbody tr").count();
  await page.route(/\/api\/trpc\/.*leads\.pool/, (route) => route.abort("connectionrefused"));
  await page.getByRole("button", { name: "Show more leads", exact: true }).click();
  await expect(page.getByText("More leads could not be loaded", { exact: true })).toBeVisible();
  await expect(page.locator(".pool-list tbody tr")).toHaveCount(rows);
  await expect(page.locator(".pool-list")).toContainText("not loaded");
  await expect(page.locator(".pool-list")).not.toContainText("not saved");
});

test("a failed refresh reports the read failure after a successful save", async ({ page }) => {
  await signIn(page, "agent");
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await page.getByLabel("Note", { exact: true }).fill("Saved while the refresh is unavailable.");
  await page.route(/\/api\/trpc\/.*leads\.get/, (route) => route.abort("connectionrefused"));
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Note added");
  await expect(
    page.getByText("The latest lead could not be loaded", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Hye-jin Park", exact: true })).toBeVisible();
  await page.unrouteAll();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByText("Saved while the refresh is unavailable.", { exact: true }),
  ).toBeVisible();
});

test("empty and failed workspaces tell the viewer what happened", async ({ page }) => {
  await signIn(page, "agent");
  const api = rpc(page);
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
      key: randomUUID(),
      channel: "call",
      outcome: "noAnswer",
      note: "Empty queue fixture.",
    });
    await api.leads.close.mutate({ id: row.id, key: randomUUID(), closing: { kind: "won" } });
  }
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "You have no open leads", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".ph-sub")).not.toContainText("0 overdue");
  await expect(page.getByRole("heading", { name: "Choose a lead", exact: true })).toHaveCount(0);
  await page.getByRole("radio", { name: "Manager", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Lead pool", exact: true })).toBeVisible();
  const agents = await api.leads.agents.query({});
  const receiving = agents.find((agent) => agent.name === "Ffion Pryce");
  const empty = agents.find((agent) => agent.name === "Dele Akinwale");
  if (!receiving || !empty) throw new Error("Missing fixture");
  const pool = await api.leads.pool.query({ limit: 100 });
  await api.leads.assign.mutate({
    leadIds: pool.rows.map((row) => row.id),
    to: { ownerId: receiving.ownerId, teamId: receiving.teamId },
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Every lead has an owner", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Assign leads", exact: true })).toHaveCount(0);
  await page.goto(`${browserState().url}/?view=queue&agent=${empty.ownerId}`);
  await expect(
    page.getByRole("heading", { name: "Dele Akinwale has no open leads", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("You have no open leads", { exact: true })).toHaveCount(0);
  await page.goto(`${browserState().url}/?view=queue&agent=00000000-0000-7000-8000-000000000101`);
  await expect(
    page.getByText("The queue could not be opened", { exact: true }).first(),
  ).toBeVisible();
  const deniedRole = await page.request.post(`${browserState().url}/api/auth/demo`, {
    headers: { origin: browserState().url },
    data: { role: "accountant" },
  });
  expect(deniedRole.status()).toBe(200);
  await page.goto(`${browserState().url}/?view=pool`);
  await expect(page.getByText("The lead pool could not be opened", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Assign leads", exact: true })).toHaveCount(0);
});
