import { expect, type Page } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { signIn } from "./support.ts";
import { browserState, browserDirectory } from "./paths.ts";

export async function readmeJourney(page: Page, recover?: () => Promise<void>) {
  const readme = await readFile(new URL("../../../../README.md", import.meta.url), "utf8");
  const control = (step: number, name: string) => {
    const line = readme.split("\n").find((line) => line.startsWith(`${String(step)}. `));
    expect(line).toContain(`**${name}**`);
    return name;
  };
  const messages: { type: string; text: string }[] = [];
  page
    .context()
    .on("console", (message) => messages.push({ type: message.type(), text: message.text() }));
  page
    .context()
    .on("weberror", (event) => messages.push({ type: "weberror", text: event.error().message }));
  await signIn(page, "manager");
  await page.getByRole("radio", { name: control(1, "Manager"), exact: true }).click();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: control(1, "Lead pool"), exact: true })
    .click();
  const leads = page.getByRole("checkbox", { name: /^Select / }).filter({ visible: true });
  await leads.nth(1).check();
  await leads.nth(2).check();
  await page.getByRole("tab", { name: control(1, "Round-robin"), exact: true }).click();
  await page.getByRole("button", { name: control(1, "Preview 2 leads"), exact: true }).click();
  await expect(page.getByRole("region", { name: "Assignment preview", exact: true })).toBeVisible();
  await page.getByRole("button", { name: control(1, "Assign 2 leads"), exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "2 leads were assigned" })).toBeVisible();

  await page.getByRole("radio", { name: control(2, "Agent"), exact: true }).click();
  await page.getByRole("link", { name: `Open ${control(2, "Hye-jin Park")}`, exact: true }).click();
  await page.getByRole("button", { name: control(2, "Log an attempt"), exact: true }).click();
  await page.getByRole("radio", { name: control(2, "Spoke to them"), exact: true }).click();
  await page
    .getByRole("textbox", { name: control(2, "Note"), exact: true })
    .fill("Confirmed the evening class and price.");
  await page.getByRole("button", { name: control(2, "Save attempt"), exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Attempt saved" })).toBeVisible();
  await page.getByRole("button", { name: control(2, "Close lead"), exact: true }).click();
  await page.getByRole("radio", { name: control(2, "Won"), exact: true }).click();
  await page.getByRole("button", { name: control(2, "Close as won"), exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "An account was opened" })).toBeVisible();

  await page.getByRole("radio", { name: control(3, "Agent"), exact: true }).click();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: control(3, "Accounts"), exact: true })
    .click();
  await page
    .getByRole("region", { name: "Accounts", exact: true })
    .getByRole("link")
    .filter({ hasText: control(3, "Leila Farouk") })
    .click();
  await page.getByRole("link", { name: control(3, "Create card checkout"), exact: true }).click();
  await page
    .getByRole("textbox", { name: control(3, "Amount"), exact: true })
    .fill(control(3, "395.00"));
  await page.getByRole("button", { name: control(3, "Create checkout"), exact: true }).click();
  const paymentPath = await page
    .getByRole("link", { name: "Go to payment", exact: true })
    .getAttribute("href");
  if (!paymentPath) throw new Error("Missing payment route.");
  const popup = page.context().waitForEvent("page");
  await page.getByRole("link", { name: control(3, "Open the page"), exact: true }).click();
  const sandbox = await popup;
  await expect(page).toHaveURL(`${browserState().url}${paymentPath}`);
  await sandbox.getByText(control(3, "Drop it"), { exact: true }).click();
  await sandbox.getByRole("button", { name: control(3, "Pay \u00a3395.00"), exact: true }).click();
  await expect(sandbox.getByRole("status")).toContainText("Paid in the sandbox");
  await sandbox.close();
  await page.bringToFront();
  await page.getByRole("radio", { name: control(3, "Accountant"), exact: true }).click();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: control(3, "Payments"), exact: true })
    .click();
  await page
    .getByRole("region", { name: "Payments", exact: true })
    .locator(`a[href="${paymentPath}"]`)
    .filter({ visible: true })
    .click();
  await recover?.();
  const detail = page.getByRole("article", { name: "Payment detail" });
  await expect(detail.getByRole("heading", { name: "Credited once", exact: true })).toBeVisible({
    timeout: 75000,
  });
  await expect(detail.getByText("The reconciler", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Payment outcome" })).toContainText(
    "1ledger posting",
  );
  await mkdir(browserDirectory, { recursive: true });
  await writeFile(
    join(browserDirectory, "readme-journey.json"),
    JSON.stringify({ appTabAfterOpen: `${browserState().url}${paymentPath}`, messages }, null, 2),
  );
  expect(
    messages.filter((message) => message.type === "error" || message.type === "weberror"),
  ).toEqual([]);
}
