import { test, expect } from "@playwright/test";
import { signIn, rpc } from "./support.ts";
import { browserState } from "./paths.ts";

test("both money forms belong to Payments in the address, header and navigation", async ({
  page,
}) => {
  await signIn(page, "manager");
  const accounts = await rpc(page).accounts.list.query({ limit: 100 });
  const id = accounts.items[0]!.id;
  for (const label of ["Create card checkout", "Record manual payment"]) {
    await page.goto(`${browserState().url}/accounts/${id}`);
    await page.getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(/\/payments\//);
    await expect(page.getByRole("heading", { name: "Payments", exact: true })).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Main" })
        .getByRole("link", { name: "Payments", exact: true }),
    ).toHaveAttribute("aria-current", "page");
  }
});

test("completed manual payments name their approvers and edits do not invent voided approvals", async ({
  page,
}) => {
  await signIn(page, "accountant");
  const api = rpc(page);
  const accounts = await api.accounts.list.query({ limit: 100 });
  const account = accounts.items.find((account) => account.person?.name === "Jonas Weber")!;
  const ledger = await api.accounts.ledger.query({ id: account.id });
  const entry = ledger.balances
    .flatMap((balance) => balance.entries)
    .find((entry) => entry.method === "manual")!;
  const payment = await api.payments.get.query({ id: entry.paymentId });
  await page.goto(`${browserState().url}/payments/${payment.id}`);
  for (const [index, label] of [
    "First approval",
    "Second approval · a different person",
  ].entries()) {
    await expect(page.getByText(label, { exact: true }).locator("..")).toContainText(
      payment.approvals[index]!.approver!.name,
    );
  }
  await expect(page.getByRole("region", { name: "Payment outcome" })).not.toContainText(
    "Later deliveries",
  );
  const pending = await api.payments.list.query({ limit: 100 });
  const edited = pending.waitingForApproval.find((row) => row.account?.name === "Yusuf Demir")!;
  await page.goto(`${browserState().url}/payments/${edited.id}`);
  await expect(
    page
      .getByRole("list", { name: "Payment events" })
      .getByRole("heading", { name: "Payment edited", exact: true }),
  ).toBeVisible();
});

test("the approval panel names the missing approver and keeps decisions together", async ({
  page,
}) => {
  await signIn(page, "accountant");
  const payments = await rpc(page).payments.list.query({ limit: 100 });
  const pending = payments.waitingForApproval.find((payment) => payment.actions.approve);
  expect(pending).toBeDefined();
  await page.goto(`${browserState().url}/payments/${pending!.id}`);
  await expect(page.getByText("Waiting for a second approver", { exact: true })).toBeVisible();
  const approve = page.getByRole("button", { name: /^Approve as/ });
  const reject = page.getByRole("button", { name: "Reject payment", exact: true });
  await expect(reject).toBeDisabled();
  await approve.scrollIntoViewIfNeeded();
  const approveBox = await approve.boundingBox();
  const rejectBox = await reject.boundingBox();
  expect(approveBox).not.toBeNull();
  expect(rejectBox).not.toBeNull();
  expect(Math.abs(approveBox!.y - rejectBox!.y)).toBeLessThan(2);
});

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
  await expect(
    page
      .getByRole("article", { name: "Payment detail" })
      .getByText("Paid after close", { exact: true }),
  ).toBeVisible();
  await expect(comparison).toContainText("Expired");
  await expect(comparison).toContainText("Paid");
  await expect(comparison).toContainText("The state");
  await expect(comparison).toContainText("The amount and the currency match.");
  const record = await rpc(page).payments.get.query({ id: late!.id });
  expect(record.soldBy).not.toBeNull();
  await expect(
    page.getByRole("article", { name: "Payment detail" }).getByText(/Sold by/),
  ).toContainText(record.soldBy!.name);
  const mismatch = payments.needsReview.find(
    (payment) =>
      payment.state.status === "needsReview" && payment.state.reason === "amount mismatch",
  );
  expect(mismatch).toBeDefined();
  await page.goto(`${browserState().url}/payments/${mismatch!.id}`);
  await expect(comparison).toContainText("The amount. The currency matches.");
  await expect(comparison).not.toContainText("The state");
});
