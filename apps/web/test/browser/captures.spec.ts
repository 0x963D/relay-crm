import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { accessibility, rpc, settleFrame, signIn } from "./support.ts";
import { browserState, captureDirectory } from "./paths.ts";
test.use({ deviceScaleFactor: 2 });
test("@capture approved lead-work frames", async ({ page, context }) => {
  await mkdir(captureDirectory, { recursive: true });
  const captures: string[] = [];
  async function capture(name: string) {
    await settleFrame(page);
    await page.screenshot({ path: join(captureDirectory, `${name}.png`) });
    captures.push(name);
  }
  await page.goto(browserState().signInUrl);
  await page.getByLabel("Work email").fill("priya.raman@tidewell.example");
  await page.getByLabel("Work email").focus();
  await capture("01-sign-in-email");
  await page.getByRole("button", { name: "Send me a code", exact: true }).click();
  await page.getByLabel("6-digit code").fill("417");
  await capture("02-sign-in-code");
  await page.context().clearCookies();
  await signIn(page, "manager");
  let pool = await rpc(page).leads.pool.query({ limit: 100 });
  for (const name of ["Chiara Russo", "Marek Dvorak"]) {
    const control = page.getByRole("checkbox", { name: `Select ${name}`, exact: true });
    if (!(await control.count()))
      await page.getByRole("button", { name: "Show more leads", exact: true }).click();
    await control.check();
  }
  await page.getByRole("radio", { name: /Noor Haddad/ }).check();
  await capture("03-pool-assign-by-hand");
  await page.reload();
  await page.getByRole("tab", { name: "Round-robin", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select all shown leads", exact: true }).check();
  const ids = pool.rows.slice(0, 12).map((row) => row.id);
  for (const row of pool.rows.slice(0, 14))
    await page
      .getByRole("checkbox", { name: `Select ${row.name ?? row.email}`, exact: true })
      .setChecked(ids.includes(row.id));
  await page.getByRole("button", { name: "Preview 12 leads", exact: true }).click();
  await expect(page.getByText("Not assigned yet", { exact: true })).toBeVisible();
  await accessibility(page, "preview");
  await capture("04-pool-round-robin-preview");
  const agents = await rpc(page).leads.agents.query({});
  const dele = agents.find((a) => a.name === "Dele Akinwale");
  const ffion = agents.find((a) => a.name === "Ffion Pryce");
  if (!dele || !ffion) throw new Error("Missing demo agent");
  const other = await context.newPage();
  await other.goto(browserState().url);
  await rpc(other).leads.assign.mutate({
    leadIds: ids.slice(0, 3),
    to: { ownerId: ffion.ownerId, teamId: ffion.teamId },
  });
  await other.close();
  await page.getByRole("button", { name: "Assign 12 leads", exact: true }).click();
  await expect(page.locator("[data-slot=alert]")).toContainText("Nothing was assigned");
  await accessibility(page, "stale-preview");
  await capture("05-pool-stale-preview-refused");
  const deniedLead = (await rpc(page).leads.pool.query({ limit: 14 })).rows[0]?.id;
  await page
    .getByRole("radiogroup", { name: "View the demo as" })
    .getByRole("radio", { name: "Agent", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "My queue", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Hye-jin Park", exact: true })).toBeVisible();
  await capture("06-work-queue");
  await page.getByRole("button", { name: "Log an attempt", exact: true }).click();
  await page.getByLabel("Call back", { exact: true }).check();
  await page
    .getByLabel("Day", { exact: true })
    .fill(new Date(Date.now() + 86400000).toISOString().slice(0, 10));
  await page.getByLabel("Time", { exact: true }).fill("09:30");
  await page
    .getByLabel("Note", { exact: true })
    .fill("Rang out, no voicemail. Trying again after tomorrow's night shift.");
  await accessibility(page, "attempt");
  await capture("07-lead-log-attempt");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Close lead", exact: true }).click();
  await page
    .getByLabel("Why was it lost?", { exact: true })
    .fill("Chose a school closer to her home");
  await accessibility(page, "close-lost");
  await capture("08-lead-close");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByLabel("Appearance").first().selectOption("dark");
  await capture("16-work-queue-dark");
  await page.getByLabel("Appearance").first().selectOption("light");
  await page.setViewportSize({ width: 390, height: 1340 });
  await accessibility(page, "queue-phone");
  await capture("14-work-queue-phone");
  await page.setViewportSize({ width: 1440, height: 900 });
  const strips: Buffer[] = [];
  for (const role of ["manager", "agent", "accountant"] as const) {
    await page
      .getByRole("radiogroup", { name: "View the demo as" })
      .getByRole("radio", { name: role.charAt(0).toUpperCase() + role.slice(1), exact: true })
      .click();
    await expect(
      page.getByRole("radio", { name: role.charAt(0).toUpperCase() + role.slice(1), exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole("heading", {
        name: role === "manager" ? "Lead pool" : role === "agent" ? "My queue" : "Payments",
        exact: true,
      }),
    ).toBeVisible();
    if (role === "agent")
      await expect(
        page.getByRole("heading", { name: "Overdue callbacks", exact: true }),
      ).toBeVisible();
    if (role === "manager") await expect(page.locator(".pool-list tbody tr").first()).toBeVisible();
    await accessibility(page, `demo-role-${role}`);
    await page.evaluate(() => document.fonts.ready);
    strips.push(await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 320 } }));
  }
  const composite = await context.newPage();
  await composite.setViewportSize({ width: 1440, height: 996 });
  await composite.setContent(
    `<html><body style="margin:0;background:#0E1138;display:flex;flex-direction:column;gap:18px">${strips.map((buffer) => `<img style="display:block;width:1440px;height:320px" src="data:image/png;base64,${buffer.toString("base64")}">`).join("")}</body></html>`,
  );
  await composite.screenshot({ path: join(captureDirectory, "13-demo-role-switcher.png") });
  await composite.close();
  captures.push("13-demo-role-switcher");
  await page
    .getByRole("radiogroup", { name: "View the demo as" })
    .getByRole("radio", { name: "Agent", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "My queue", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Overdue callbacks", exact: true })).toBeVisible();
  await page.waitForLoadState("load");
  const tiles: { title: string; image: Buffer }[] = [];
  const { promise: gate, resolve: release } = Promise.withResolvers<boolean>();
  await page.route(/\/api\/trpc\/.*leads\.queue/, async (route) => {
    await gate;
    await route.continue();
  });
  await page.reload();
  await expect(page.getByRole("status", { name: "Loading leads" })).toBeVisible();
  tiles.push({
    title: "Queue · loading",
    image: await page.getByRole("status", { name: "Loading leads" }).screenshot(),
  });
  release(true);
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.getByRole("heading", { name: "Overdue callbacks", exact: true })).toBeVisible();
  if (deniedLead) {
    await page.goto(`${browserState().url}/?view=queue&lead=${deniedLead}`);
    await expect(page.getByRole("heading", { name: "You cannot open this lead" })).toBeVisible();
    await accessibility(page, "access-refused");
    tiles.push({
      title: "Lead · access denied",
      image: await page.getByLabel("Lead detail").locator(".empty").screenshot(),
    });
  }
  await page.goto(`${browserState().url}/?view=queue`);
  const own = await rpc(page).leads.queue.query({ limit: 100 });
  for (const item of [
    own.overdueCallbacks,
    own.dueToday,
    own.noCallbackSet,
    own.notYetCalled,
    own.later,
  ].flat()) {
    await rpc(page).leads.logAttempt.mutate({
      id: item.id,
      key: crypto.randomUUID(),
      channel: "call",
      outcome: "noAnswer",
      note: "Invented capture fixture attempt.",
    });
    await rpc(page).leads.close.mutate({
      id: item.id,
      key: crypto.randomUUID(),
      closing: { kind: "won" },
    });
  }
  await page.reload();
  await expect(page.getByRole("heading", { name: "You have no open leads" })).toBeVisible();
  await accessibility(page, "queue-empty");
  tiles.push({
    title: "Queue · empty",
    image: await page.locator(".queue-list .empty").screenshot(),
  });
  await page
    .getByRole("radiogroup", { name: "View the demo as" })
    .getByRole("radio", { name: "Manager", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Lead pool", exact: true })).toBeVisible();
  pool = await rpc(page).leads.pool.query({ limit: 100 });
  await rpc(page).leads.assign.mutate({
    leadIds: pool.rows.map((row) => row.id),
    to: { ownerId: dele.ownerId, teamId: dele.teamId },
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Every lead has an owner" })).toBeVisible();
  await accessibility(page, "pool-empty");
  tiles.push({
    title: "Lead pool · empty",
    image: await page.locator(".pool-list .empty").screenshot(),
  });
  await page.context().clearCookies();
  await page.goto(browserState().signInUrl);
  await page.getByLabel("Work email").fill("priya.raman@tidewell.example");
  await page.getByRole("button", { name: "Send me a code", exact: true }).click();
  await page.getByLabel("6-digit code").fill("000000");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("[data-slot=alert]")).toBeVisible();
  await accessibility(page, "code-refused-capture");
  tiles.push({
    title: "Sign-in · code refused",
    image: await page.locator(".sign-sheet").screenshot(),
  });
  const statePage = await context.newPage();
  await statePage.setViewportSize({ width: 1440, height: 900 });
  await statePage.setContent(
    `<html><body style="margin:0;background:#0E1138;color:#F3F4FF;font-family:system-ui;padding:28px;box-sizing:border-box"><h1 style="margin:0 0 12px">States that change what the person does next</h1><p>Actual loading, empty and refused states. The approval state belongs to the payment screens.</p><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:18px">${tiles.map((tile) => `<section style="min-width:0;background:#161A52;padding:12px;border:1px solid #3D4284;border-radius:12px"><div style="height:270px;overflow:hidden;background:white;border-radius:8px"><img style="display:block;width:100%;height:100%;object-fit:contain;object-position:top" src="data:image/png;base64,${tile.image.toString("base64")}"></div><h2 style="font-size:17px">${tile.title}</h2></section>`).join("")}</div></body></html>`,
  );
  await statePage.screenshot({ path: join(captureDirectory, "15-states.png") });
  await statePage.close();
  captures.push("15-states");
  await writeFile(
    join(captureDirectory, "manifest.json"),
    JSON.stringify(
      {
        measured: true,
        scale: 2,
        captures,
        notes:
          "Frames 13 and 15 assemble actual app captures. Payment content is outside this task. The API determines all names, counts, timestamps and assignment results.",
      },
      null,
      2,
    ),
  );
});
