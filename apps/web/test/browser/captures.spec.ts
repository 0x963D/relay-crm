import { test, expect, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { signIn, rpc, settleFrame } from "./support.ts";
import { browserState, captureDirectory, legacyStyles } from "./paths.ts";

async function frameCapture(page: Page) {
  await mkdir(captureDirectory, { recursive: true });
  const legacy = legacyStyles
    ? (await readFile(legacyStyles, "utf8")).replace(/@import[^;]+;/g, "")
    : null;
  await page.clock.setFixedTime(new Date());
  return async (name: string) => {
    for (const theme of ["light", "dark"]) {
      await page.locator('select[aria-label="Appearance"]:visible').first().selectOption(theme);
      await settleFrame(page);
      const metrics = async () =>
        page
          .locator(
            ".theme, .so-time, .lead-title button, .pool-list .check-cell, .pool-list .check-target, .otp-slot",
          )
          .evaluateAll((elements) =>
            elements.map((element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return {
                text: element.textContent,
                className: element.getAttribute("class"),
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                lineHeight: style.lineHeight,
                padding: style.padding,
                border: style.border,
                display: style.display,
                minWidth: style.minWidth,
                color: style.color,
              };
            }),
          );
      const currentMetrics = await metrics();
      await page.screenshot({ path: join(captureDirectory, `${name}-${theme}.png`) });
      if (legacy) {
        const style = await page.addStyleTag({ content: legacy });
        await page.screenshot({ path: join(captureDirectory, `${name}-${theme}.legacy.png`) });
        await writeFile(
          join(captureDirectory, `${name}-${theme}.metrics.json`),
          JSON.stringify({ current: currentMetrics, legacy: await metrics() }, null, 2),
        );
        await style.evaluate((element) => element.parentNode?.removeChild(element));
      }
    }
    await page.locator('select[aria-label="Appearance"]:visible').first().selectOption("light");
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
  await page.context().clearCookies();
  await signIn(page, "manager");
  await page.getByRole("checkbox", { name: "Select Chiara Russo", exact: true }).check();
  await capture("03-pool");
  await page.getByRole("tab", { name: "Round-robin", exact: true }).click();
  await page.getByRole("button", { name: "Preview 1 lead", exact: true }).click();
  await expect(page.getByText("Not assigned yet", { exact: true })).toBeVisible();
  await capture("04-preview");
  const agents = await rpc(page).leads.agents.query({});
  const pool = await rpc(page).leads.pool.query({ limit: 100 });
  const changed = pool.rows.find((row) => row.name === "Chiara Russo");
  const agent = agents.find((person) => person.name === "Ffion Pryce");
  if (!changed || !agent) throw new Error("Missing fixture");
  await rpc(page).leads.assign.mutate({
    leadIds: [changed.id],
    to: { ownerId: agent.ownerId, teamId: agent.teamId },
  });
  await page.getByRole("button", { name: "Assign 1 lead", exact: true }).click();
  await expect(page.locator("[data-slot=alert]")).toContainText("Nothing was assigned");
  await capture("05-stale");
  await page.getByRole("radio", { name: "Agent", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Hye-jin Park", exact: true })).toBeVisible();
  await capture("06-queue");
  await page.getByRole("button", { name: "Log an attempt", exact: true }).click();
  await page.getByLabel("Note", { exact: true }).fill("Rang out. Will call after the night shift.");
  await capture("07-attempt");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Close lead", exact: true }).click();
  await capture("08-close");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  for (const width of [1440, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await capture(`queue-${String(width)}`);
  }
  await page
    .getByRole("button")
    .filter({ has: page.getByText("Hye-jin Park", { exact: true }) })
    .click();
  await expect(page.getByRole("heading", { name: "Hye-jin Park", exact: true })).toBeVisible();
  await capture("lead-390");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("radio", { name: "Manager", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Lead pool", exact: true })).toBeVisible();
  for (const width of [1440, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await capture(`pool-${String(width)}`);
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
  await page.goto(`${browserState().url}/?view=queue&agent=00000000-0000-7000-8000-000000000101`);
  await expect(
    page.getByText("The queue could not be opened", { exact: true }).first(),
  ).toBeVisible();
  await capture("15-queue-failed");
  await page.getByRole("radio", { name: "Agent", exact: true }).click();
  await expect(page.getByRole("heading", { name: "My queue", exact: true })).toBeVisible();
  await page.goto(`${browserState().url}/?view=queue&lead=${inaccessible.id}`);
  await expect(
    page.getByRole("heading", { name: "You cannot open this lead", exact: true }),
  ).toBeVisible();
  await capture("15-lead-refused");
  await page.goto(`${browserState().url}/?view=queue`);
  await page.getByRole("button", { name: "Log an attempt", exact: true }).click();
  await page.getByLabel("Note", { exact: true }).fill("Keep this draft.");
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
  await page.goto(`${browserState().url}/?view=queue&agent=${dele.ownerId}`);
  await expect(
    page.getByRole("heading", { name: "Dele Akinwale has no open leads", exact: true }),
  ).toBeVisible();
  await capture("15-manager-empty");
  await api.leads.assign.mutate({
    leadIds: pool.rows.map((row) => row.id),
    to: { ownerId: receiving.ownerId, teamId: receiving.teamId },
  });
  await page.goto(`${browserState().url}/?view=pool`);
  await expect(
    page.getByRole("heading", { name: "Every lead has an owner", exact: true }),
  ).toBeVisible();
  await capture("15-pool-empty");
  const role = await page.request.post(`${browserState().url}/api/auth/demo`, {
    headers: { origin: browserState().url },
    data: { role: "accountant" },
  });
  expect(role.status()).toBe(200);
  await page.goto(`${browserState().url}/?view=pool`);
  await expect(page.getByText("The lead pool could not be opened", { exact: true })).toBeVisible();
  await capture("15-pool-failed");
});
