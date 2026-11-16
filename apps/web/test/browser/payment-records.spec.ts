import { test, expect } from "@playwright/test";
import { signIn, rpc } from "./support.ts";
import { browserState } from "./paths.ts";

test("payment groups share columns and align amount headers with their figures", async ({
  page,
}) => {
  await signIn(page, "accountant");
  const amounts = page.getByRole("columnheader", { name: "Amount", exact: true });
  const geometry = await amounts.evaluateAll((headers) =>
    headers.map((header) => ({
      x: Math.round(header.getBoundingClientRect().x),
      align: getComputedStyle(header).textAlign,
    })),
  );
  expect(geometry.length).toBeGreaterThan(1);
  expect(new Set(geometry.map((header) => header.x)).size).toBe(1);
  expect(geometry.every((header) => header.align === "end" || header.align === "right")).toBe(true);
  const approval = page.getByRole("table", { name: "Waiting for approval", exact: true });
  expect(await approval.locator("tbody tr td:last-child svg").count()).toBeGreaterThan(0);
});

test("payment rows and ledger amounts fit at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "accountant");
  const payments = await rpc(page).payments.list.query({ limit: 100 });
  async function noOverflow() {
    expect(
      await page
        .locator("[data-slot=table-container]")
        .evaluateAll(
          (elements) =>
            elements.filter(
              (element) =>
                element.getBoundingClientRect().width > 0 &&
                element.scrollWidth > element.clientWidth + 1,
            ).length,
        ),
    ).toBe(0);
  }
  await noOverflow();
  await expect(
    page.getByRole("region", { name: "Payments", exact: true }).getByRole("link").first(),
  ).toContainText(/mismatch|paid after close/i);
  const accounts = await rpc(page).accounts.list.query({ limit: 100 });
  const funded = accounts.items.find((account) => account.balances?.length);
  expect(funded).toBeDefined();
  await page.goto(`${browserState().url}/accounts/${funded!.id}/ledger`);
  await noOverflow();
  const ledger = page.getByRole("region", { name: "Account ledger", exact: true });
  await expect(ledger).toContainText("Credit");
  await expect(ledger).toContainText("Balance");
  expect(payments.needsReview.length).toBeGreaterThan(0);
});

test("opening a payment moves focus without outlining its amount", async ({ page }) => {
  await signIn(page, "accountant");
  const payments = await rpc(page).payments.list.query({ limit: 100 });
  await page.goto(`${browserState().url}/payments/${payments.needsReview[0]!.id}`);
  const amount = page
    .getByRole("article", { name: "Payment detail" })
    .getByRole("heading", { level: 2 });
  await expect(amount).toBeFocused();
  await expect(amount).toHaveCSS("outline-style", "none");
});

test("payment events show causes before effects and omit an unowed webhook", async ({ page }) => {
  await signIn(page, "accountant");
  const payments = await rpc(page).payments.list.query({ limit: 100 });
  const late = payments.needsReview.find(
    (payment) =>
      payment.state.status === "needsReview" && payment.state.reason === "paid after close",
  );
  expect(late).toBeDefined();
  await page.goto(`${browserState().url}/payments/${late!.id}`);
  const events = page.getByRole("list", { name: "Payment events" });
  await expect(events.getByRole("heading")).toHaveText([
    "Checkout created",
    "The reconciler asked the provider",
    "Payment closed as expired",
    "The webhook arrived late",
    "Moved to needs review",
  ]);
  await expect(events).not.toContainText("No webhook was recorded");
});

test("review compares the fact that differs, including a paid report after expiry", async ({
  page,
}) => {
  await signIn(page, "accountant");
  const payments = await rpc(page).payments.list.query({ limit: 100 });
  const late = payments.needsReview.find(
    (payment) =>
      payment.state.status === "needsReview" && payment.state.reason === "paid after close",
  );
  expect(late).toBeDefined();
  await page.goto(`${browserState().url}/payments/${late!.id}`);
  const comparison = page.getByRole("region", { name: "Review comparison" });
  await expect(comparison).toContainText("Expired");
  await expect(comparison).toContainText("Paid");
  await expect(comparison).toContainText("The state");
  await expect(comparison).toContainText("The amount and the currency match.");
  const mismatch = payments.needsReview.find(
    (payment) =>
      payment.state.status === "needsReview" && payment.state.reason === "amount mismatch",
  );
  expect(mismatch).toBeDefined();
  await page.goto(`${browserState().url}/payments/${mismatch!.id}`);
  await expect(comparison).toContainText("The amount. The currency matches.");
  await expect(comparison).not.toContainText("The state");
});
