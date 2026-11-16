import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { signIn, rpc, settleFrame } from "./support.ts";
import { browserState, captureDay } from "./paths.ts";
test("@capture @readme fixed-day screenshots of the running product", async ({ page }) => {
  if (!captureDay) throw new Error("Use pnpm capture:readme for the fixed-day images.");
  const directory = fileURLToPath(new URL("../../../../docs/images/", import.meta.url));
  await mkdir(directory, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.setFixedTime(new Date(browserState().today));
  async function capture(name: string) {
    for (const theme of ["light", "dark"]) {
      await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption(theme);
      await settleFrame(page);
      await page.screenshot({ path: join(directory, `${name}-${theme}.png`) });
    }
  }
  await signIn(page, "agent");
  await page.getByRole("link", { name: "Open Hye-jin Park", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Hye-jin Park", exact: true })).toBeVisible();
  await capture("queue");
  await page.getByRole("radio", { name: "Manager", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select all visible leads", exact: true }).check();
  await page.getByRole("tab", { name: "Round-robin", exact: true }).click();
  await page.getByRole("button", { name: /^Preview \d+ leads$/ }).click();
  await expect(page.getByRole("region", { name: "Assignment preview", exact: true })).toBeVisible();
  await capture("pool");
  await page.getByRole("radio", { name: "Accountant", exact: true }).click();
  const api = rpc(page);
  const accounts = await api.accounts.list.query({ limit: 100 });
  const account = accounts.items.find((row) => row.person?.name === "Jonas Weber");
  if (!account) throw new Error("The seeded account is missing.");
  const ledger = await api.accounts.ledger.query({ id: account.id });
  const entry = ledger.balances
    .flatMap((balance) => balance.entries)
    .find((row) => row.completion.by === "reconciler");
  const payment = entry ? await api.payments.get.query({ id: entry.paymentId }) : null;
  if (!payment) throw new Error("The seeded reconciler payment is missing.");
  await page.goto(`${browserState().url}/payments/${payment.id}`);
  await expect(page.getByRole("heading", { name: "Credited once", exact: true })).toBeVisible();
  await capture("payment");
});
