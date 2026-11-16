import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { signPaymentBody } from "../../src/server/payments/webhook.ts";
import { signIn, rpc, accessibility, latestCode, tabTo } from "./support.ts";
import { browserState, captureDirectory } from "./paths.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const webhookSecret = () =>
  browserState().webhookSecret ?? "fake-browser-webhook-secret-abcdefghijklmnopqrstuvwxyz";
const reconcileSecret = () =>
  browserState().reconcileSecret ?? "fake-browser-reconcile-secret-abcdefghijklmnopqrstuvwxyz";
async function openAccount(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Accounts" })
    .click();
  await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
  const account = page
    .getByRole("region", { name: "Accounts", exact: true })
    .getByRole("link")
    .filter({ hasText: name });
  for (let pageNumber = 0; pageNumber < 10 && (await account.count()) === 0; pageNumber++) {
    const more = page.getByRole("button", { name: "Show more accounts", exact: true });
    await more.click();
    await expect(
      page.getByRole("button", { name: /Show more accounts|All accounts shown/ }),
    ).not.toHaveAttribute("aria-busy", "true");
  }
  await account.click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}
test("card checkout recovers a dropped webhook and credits once; the pay link never returns", async ({
  page,
}) => {
  await signIn(page, "agent");
  await openAccount(page, "Leila Farouk");
  await expect(page.getByText("Balance", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Create card checkout", exact: true }).click();
  await page.getByRole("textbox", { name: "Amount", exact: true }).fill("395.00");
  await accessibility(page, "checkout-form");
  await page.getByRole("button", { name: "Create checkout", exact: true }).click();
  const link = page.getByRole("textbox", { name: "Pay link", exact: true });
  await expect(link).toBeVisible();
  const capability = await link.inputValue();
  const paymentPath = await page
    .getByRole("link", { name: "Go to payment", exact: true })
    .getAttribute("href");
  if (!paymentPath) throw new Error("Missing payment route");
  const id = paymentPath.split("/").at(-1) ?? "";
  await accessibility(page, "checkout-created");
  await page.getByRole("link", { name: "Open the page", exact: true }).click();
  await expect(page.getByRole("heading", { name: "SANDBOX PROVIDER", exact: true })).toBeVisible();
  await page.goBack();
  await expect(link).toHaveCount(0);
  await page.reload();
  await page.getByRole("textbox", { name: "Amount", exact: true }).fill("1.00");
  await page.getByRole("button", { name: "Create checkout", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "already has a payment in progress" }),
  ).toBeVisible();
  await expect(link).toHaveCount(0);
  expect(await page.content()).not.toContain(capability);
  await page.goto(capability);
  await accessibility(page, "sandbox-checkout");
  await page.getByRole("radio", { name: /^Drop it/ }).check();
  await page.getByRole("button", { name: "Pay £395.00", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Paid in the sandbox");
  const response = await page.request.post(`${browserState().url}/api/payments/reconcile`, {
    headers: { authorization: `Bearer ${reconcileSecret()}` },
  });
  expect(response.ok()).toBe(true);
  await expect
    .poll(async () => (await rpc(page).payments.get.query({ id })).state.status)
    .toBe("completed");
  const body = JSON.stringify({
    eventId: randomUUID(),
    paymentId: id,
    status: "completed",
    amount: "39500",
    currency: "GBP",
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const delivery = await page.request.post(`${browserState().url}/api/payments/webhook`, {
    headers: {
      "content-type": "application/json",
      "x-sandbox-signature": signPaymentBody(webhookSecret(), timestamp, Buffer.from(body)),
      "x-sandbox-timestamp": timestamp,
    },
    data: body,
  });
  expect(delivery.ok()).toBe(true);
  await page.goto(`${browserState().url}${paymentPath}`);
  await expect(page.getByRole("heading", { name: "Credited once", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Payment outcome" })).toContainText(
    "1ledger posting",
  );
  await expect(page.getByRole("list", { name: "Payment events" })).toContainText(
    "Nothing changed.",
  );
  await expect(page.getByRole("region", { name: "Ledger posting" })).toHaveCount(0);
  expect((await rpc(page).payments.get.query({ id })).postingCount).toBe(1);
  await accessibility(page, "agent-completed-payment");
});

test("manual payment needs two other approvers and appears in the ledger; a second payment is refused", async ({
  page,
  browser,
}) => {
  await signIn(page, "manager");
  await openAccount(page, "Hana Kobayashi");
  await page.getByRole("link", { name: "Record manual payment", exact: true }).click();
  await page.getByRole("textbox", { name: "Amount", exact: true }).fill("123.45");
  await page.getByLabel("Receipt", { exact: true }).setInputFiles({
    name: "hana-transfer.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(`Invented receipt ${randomUUID()}`),
  });
  await page.getByRole("textbox", { name: "Receipt reference", exact: true }).fill("Hana transfer");
  await accessibility(page, "manual-payment-form");
  await page.getByRole("button", { name: "Send for approval", exact: true }).click();
  await expect(
    page.getByText("You recorded this payment and cannot approve it.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Approve as/ })).toHaveCount(0);
  const path = new URL(page.url()).pathname;
  const id = path.split("/").at(-1) ?? "";
  const payment = await rpc(page).payments.get.query({ id });
  await expect(
    rpc(page).payments.approve.mutate({
      id,
      version: payment.version,
      roleVersion: payment.actions.roleVersion,
    }),
  ).rejects.toMatchObject({ data: { accessFailure: "paymentRecorder" } });
  await page.goto(`${browserState().url}/accounts/${payment.accountId}/checkout`);
  await page.getByRole("textbox", { name: "Amount", exact: true }).fill("10.00");
  await page.getByRole("button", { name: "Create checkout", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "The checkout was not created" }),
  ).toContainText("already has a payment in progress");
  await expect(
    page.getByRole("link", { name: "Open the payment in progress", exact: true }),
  ).toHaveAttribute("href", path);
  await accessibility(page, "payment-conflict");
  const accountantContext = await browser.newContext();
  const accountant = await accountantContext.newPage();
  await signIn(accountant, "accountant");
  await accountant.goto(`${browserState().url}${path}`);
  await accountant.getByRole("button", { name: "Approve as first approver", exact: true }).click();
  await expect(accountant.getByRole("status")).toContainText("Your approval was recorded");
  await accessibility(accountant, "manual-one-approval");
  const secondContext = await browser.newContext();
  const second = await secondContext.newPage();
  await second.goto(`${browserState().signInUrl}/sign-in`);
  await second
    .getByRole("textbox", { name: "Work email", exact: true })
    .fill("tomasz.zielinski@tidewell.example");
  await second.getByRole("button", { name: "Send me a code", exact: true }).click();
  await expect(second.getByRole("textbox", { name: "6-digit code", exact: true })).toBeVisible();
  await second.getByRole("textbox", { name: "6-digit code", exact: true }).fill(await latestCode());
  await second.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(second.getByRole("navigation", { name: "Main" })).toBeVisible();
  await second.goto(`${browserState().url}${path}`);
  await second.getByRole("button", { name: "Approve as second approver", exact: true }).click();
  await expect(second.getByRole("heading", { name: "Credited once", exact: true })).toBeVisible();
  await second.getByRole("link", { name: "Open Hana Kobayashi’s ledger", exact: true }).click();
  await expect(second.getByRole("region", { name: "Account ledger", exact: true })).toContainText(
    "£123.45",
  );
  await expect(second.getByRole("region", { name: "Account ledger", exact: true })).toContainText(
    "Credit",
  );
  const credited = second
    .getByRole("row")
    .filter({ has: second.getByRole("link").filter({ hasText: "Repeat payment · manual" }) })
    .filter({ hasText: "£123.45" });
  await expect(credited.getByRole("cell").nth(2)).toContainText("£123.45");
  await expect(credited.getByRole("cell").nth(2)).toContainText("Credit");
  await accessibility(second, "account-ledger");
  await accountantContext.close();
  await secondContext.close();
});

test("all five sandbox choices produce their stated outcome", async ({ page }) => {
  await signIn(page, "manager");
  for (const [choice, expectedBy, reports] of [
    ["Deliver it normally", "providerWebhook", 1],
    ["Drop it", "reconciler", 1],
    ["Send it twice", "providerWebhook", 2],
    ["Send it late", "reconciler", 2],
    ["Report a different amount", "needsReview", 1],
  ] as const) {
    await openAccount(page, "Leila Farouk");
    await page.getByRole("link", { name: "Create card checkout", exact: true }).click();
    await page.getByRole("textbox", { name: "Amount", exact: true }).fill("25.00");
    await page.getByRole("button", { name: "Create checkout", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Pay link", exact: true })).toBeVisible();
    const path = await page
      .getByRole("link", { name: "Go to payment", exact: true })
      .getAttribute("href");
    if (!path) throw new Error("Missing payment route");
    const id = path.split("/").at(-1) ?? "";
    await page.getByRole("link", { name: "Open the page", exact: true }).click();
    await page.getByRole("radio", { name: new RegExp(`^${choice}`) }).check();
    await page.getByRole("button", { name: "Pay £25.00", exact: true }).click();
    if (expectedBy === "reconciler") {
      const result = await page.request.post(`${browserState().url}/api/payments/reconcile`, {
        headers: { authorization: `Bearer ${reconcileSecret()}` },
      });
      expect(result.ok()).toBe(true);
    }
    await expect
      .poll(
        async () => {
          const payment = await rpc(page).payments.get.query({ id });
          return payment.events.filter((event) =>
            ["webhookDelivery", "reconcilerCheck"].includes(event.kind),
          ).length;
        },
        { timeout: 90000 },
      )
      .toBe(reports);
    const payment = await rpc(page).payments.get.query({ id });
    expect(payment.state).toMatchObject(
      expectedBy === "needsReview"
        ? { status: "needsReview", reason: "amount mismatch" }
        : { status: "completed", by: expectedBy },
    );
    expect(payment.postingCount).toBe(expectedBy === "needsReview" ? 0 : 1);
    await page.goto(`${browserState().url}${path}`);
    await expect(
      page.getByRole("heading", {
        name: expectedBy === "needsReview" ? "Nothing was credited" : "Credited once",
        exact: true,
      }),
    ).toBeVisible();
    if (reports === 2)
      await expect(page.getByRole("list", { name: "Payment events" })).toContainText(
        "Nothing changed.",
      );
    await accessibility(page, `sandbox-outcome-${expectedBy}-${String(reports)}`);
    if (expectedBy === "needsReview") {
      await page
        .getByRole("textbox", { name: "Reason", exact: true })
        .fill("Sandbox amount differed; refund handled outside Relay CRM.");
      await page.getByRole("button", { name: "Close as failed", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("Your decision was recorded");
    }
  }
});

test("a card checkout can be created and paid with the keyboard alone", async ({ page }) => {
  await signIn(page, "agent");
  async function enter(control: ReturnType<Page["getByRole"]>) {
    await tabTo(page, control);
    await page.keyboard.press("Enter");
  }
  await enter(
    page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Accounts", exact: true }),
  );
  await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
  const account = page
    .getByRole("region", { name: "Accounts", exact: true })
    .getByRole("link")
    .filter({ hasText: "Leila Farouk" });
  for (let count = 0; count < 10 && (await account.count()) === 0; count++) {
    const more = page.getByRole("button", { name: "Show more accounts", exact: true });
    await enter(more);
    await expect(
      page.getByRole("button", { name: /Show more accounts|All accounts shown/ }),
    ).not.toHaveAttribute("aria-busy", "true");
  }
  await enter(account);
  await enter(page.getByRole("link", { name: "Create card checkout", exact: true }));
  await tabTo(page, page.getByRole("textbox", { name: "Amount", exact: true }));
  await page.keyboard.type("19.00");
  await enter(page.getByRole("button", { name: "Create checkout", exact: true }));
  await expect(page.getByRole("textbox", { name: "Pay link", exact: true })).toBeVisible();
  await enter(page.getByRole("link", { name: "Open the page", exact: true }));
  await expect(page.getByRole("heading", { name: "SANDBOX PROVIDER", exact: true })).toBeVisible();
  await enter(page.getByRole("button", { name: "Pay £19.00", exact: true }));
  await expect(page.getByRole("status")).toBeFocused();
  await enter(page.getByRole("link", { name: "go back to Relay CRM", exact: true }));
  await expect(page.getByRole("heading", { name: "Credited once", exact: true })).toBeVisible();
  await accessibility(page, "keyboard-card-completed");
});

test("receipt retry keeps the posting and refuses another attempt at the cap", async ({ page }) => {
  await signIn(page, "accountant");
  const api = rpc(page);
  const accounts = await api.accounts.list.query({ limit: 100 });
  let retryId = "";
  let cappedId = "";
  for (const account of accounts.items) {
    const ledger = await api.accounts.ledger.query({ id: account.id });
    for (const line of ledger.balances.flatMap((balance) => balance.entries)) {
      const payment = await api.payments.get.query({ id: line.paymentId });
      if (payment.receipt?.state !== "failed") continue;
      if (payment.receipt.attempts >= payment.receiptAttemptLimit) cappedId = payment.id;
      else if (payment.actions.requeueReceipt) retryId = payment.id;
    }
  }
  expect(retryId).not.toBe("");
  expect(cappedId).not.toBe("");
  await page.goto(`${browserState().url}/payments/${cappedId}`);
  const refusal = page.getByText("The receipt cannot be sent again", { exact: true });
  await refusal.scrollIntoViewIfNeeded();
  await expect(refusal).toBeVisible();
  await expect(page.getByRole("button", { name: "Send again", exact: true })).toHaveCount(0);
  await expect(api.payments.requeueReceipt.mutate({ id: cappedId })).rejects.toMatchObject({
    data: { accessFailure: "receiptAttemptLimit" },
  });
  await accessibility(page, "receipt-cap-refusal");
  await page.goto(`${browserState().url}/payments/${retryId}`);
  await page.getByRole("button", { name: "Send again", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("The receipt was queued again");
  expect((await api.payments.get.query({ id: retryId })).postingCount).toBe(1);
  await accessibility(page, "receipt-requeued");
});

test("@capture payment and account states from the seeded demo", async ({ page }) => {
  await mkdir(captureDirectory, { recursive: true });
  await signIn(page, "accountant");
  await page.clock.setFixedTime(new Date(browserState().today));
  const api = rpc(page);
  const payments = await api.payments.list.query({ limit: 100 });
  const candidates = [
    ...payments.needsReview,
    ...payments.waitingForApproval,
    ...payments.waitingForProvider,
    ...payments.decidedThisWeek,
  ];
  const accounts = await api.accounts.list.query({ limit: 100 });
  for (const account of accounts.items) {
    const ledger = await api.accounts.ledger.query({ id: account.id });
    for (const entry of ledger.balances.flatMap((balance) => balance.entries)) {
      if (!candidates.some((payment) => payment.id === entry.paymentId))
        candidates.push(await api.payments.get.query({ id: entry.paymentId }));
    }
  }
  const picked = new Map<string, string>();
  for (const row of candidates) {
    const payment = await api.payments.get.query({ id: row.id });
    const state = payment.state;
    const key =
      state.status === "completed"
        ? state.by === "reconciler"
          ? "17-reconciler"
          : state.by === "providerWebhook"
            ? "19-webhook"
            : `25-receipt-${payment.receipt?.state ?? "none"}-${String(payment.receipt?.attempts)}`
        : state.status === "needsReview"
          ? state.reason === "paid after close"
            ? "26-paid-after-close"
            : "20-review"
          : state.status === "checkoutCreated"
            ? "21-waiting"
            : state.status === "pendingApproval"
              ? "11-approval"
              : null;
    if (
      key &&
      (!picked.has(key) ||
        (key === "11-approval" && payment.account?.name === "Yusuf Demir") ||
        (key === "21-waiting" && payment.account?.name === "Marek Novak"))
    )
      picked.set(key, `/payments/${row.id}`);
    if (payment.receipt && payment.receipt.state !== "sent")
      picked.set(
        `25-receipt-${payment.receipt.state}-${String(payment.receipt.attempts)}`,
        `/payments/${row.id}`,
      );
  }
  picked.set("21-payments", "/payments");
  picked.set("24-accounts", "/accounts");
  const jonas = accounts.items.find((account) => account.person?.name === "Jonas Weber");
  if (jonas) picked.set("24-ledger", `/accounts/${jonas.id}/ledger`);
  for (const [name, path] of picked) {
    const role = name === "21-waiting" ? "Manager" : "Accountant";
    if (!(await page.getByRole("radio", { name: role, exact: true }).isChecked())) {
      await Promise.all([
        page.waitForURL(`${browserState().url}${role === "Manager" ? "/pool" : "/payments"}`),
        page.getByRole("radio", { name: role, exact: true }).click(),
      ]);
      await expect(
        page.getByRole("heading", {
          name: role === "Manager" ? "Lead pool" : "Payments",
          exact: true,
        }),
      ).toBeVisible();
    }
    await page.goto(`${browserState().url}${path}`);
    for (const theme of ["light", "dark"]) {
      await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption(theme);
      await accessibility(page, `${name}-${theme}`);
      await page.screenshot({ path: join(captureDirectory, `${name}-${theme}.png`) });
      if (name === "25-receipt-failed-12") {
        await page
          .getByText("The receipt cannot be sent again", { exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(captureDirectory, `25-cap-refusal-${theme}.png`) });
      }
    }
  }
});

test("@capture payment creation, refusals and the campaign funnel", async ({ page }) => {
  await mkdir(captureDirectory, { recursive: true });
  await page.clock.setFixedTime(new Date(browserState().today));
  await signIn(page, "manager");
  async function capture(name: string) {
    for (const theme of ["light", "dark"]) {
      await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption(theme);
      await accessibility(page, `${name}-${theme}`);
      await page.screenshot({ path: join(captureDirectory, `${name}-${theme}.png`) });
    }
  }
  await page.getByRole("link", { name: "Campaign funnel", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Campaign funnel", exact: true })).toBeVisible();
  await capture("12-funnel");
  await openAccount(page, "Leila Farouk");
  await page.getByRole("link", { name: "Record manual payment", exact: true }).click();
  await page.getByRole("textbox", { name: "Amount", exact: true }).fill("395.00");
  await capture("09-manual");
  await page.getByRole("link", { name: "Cancel", exact: true }).click();
  await page.getByRole("link", { name: "Create card checkout", exact: true }).click();
  await page.getByRole("textbox", { name: "Amount", exact: true }).fill("395.00");
  await capture("22-checkout-form");
  await page.getByRole("button", { name: "Create checkout", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Pay link", exact: true })).toBeVisible();
  await capture("22-checkout-created");
  await page.getByRole("link", { name: "Open the page", exact: true }).click();
  await expect(page.getByRole("heading", { name: "SANDBOX PROVIDER", exact: true })).toBeVisible();
  await accessibility(page, "23-sandbox");
  await page.screenshot({ path: join(captureDirectory, "23-sandbox.png") });
  await page.goto(browserState().url);
  await openAccount(page, "Yusuf Demir");
  await page.getByRole("link", { name: "Record manual payment", exact: true }).click();
  await page.getByRole("textbox", { name: "Amount", exact: true }).fill("480.00");
  await page.getByLabel("Receipt", { exact: true }).setInputFiles({
    name: "yusuf-transfer.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("An invented second receipt"),
  });
  await page.getByRole("button", { name: "Send for approval", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "already has a payment in progress" }),
  ).toBeVisible();
  await capture("10-manual-refused");
});
