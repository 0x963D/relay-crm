import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createTestDatabase } from "@relay/store/testing/database";
import { recoverDemoSeed } from "../../src/server/demo-maintenance.ts";
import { parseEnv } from "../../src/server/env.ts";
import { hostedRecoveryNote } from "../../src/lib/demo-copy.ts";
import { serve } from "../support/production-server.ts";
import { hostedDemoEnv } from "../support/hosted-demo.ts";
import { browserState, captureDirectory } from "./paths.ts";
import { rpc, settleFrame, signIn } from "./support.ts";

const screenshots = join(captureDirectory, "demo-email");

async function captureSignIn(page: Page, url: string, mode: string, size: string) {
  await page.context().clearCookies();
  await page.goto(`${url}/sign-in`);
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await settleFrame(page);
  await page.screenshot({ path: join(screenshots, `${mode}-sign-in-${size}.png`) });
}

async function captureReceipt(page: Page, url: string, id: string, mode: string, size: string) {
  await page.goto(`${url}/payments/${id}`);
  const panel = page.getByRole("region", { name: "Receipt", exact: true });
  await expect(panel.getByText("Receipt email", { exact: true })).toBeVisible();
  await settleFrame(page);
  await panel.screenshot({ path: join(screenshots, `${mode}-receipt-${size}.png`) });
  return panel;
}

test("hosted demo refuses email codes and records a suppressed receipt after a dropped webhook", async ({
  page,
}) => {
  const smtpUrl = browserState().url;
  await signIn(page, "accountant");
  const usualApi = rpc(page);
  const usualAccounts = await usualApi.accounts.list.query({ limit: 100 });
  let smtpId: string | undefined;
  for (const account of usualAccounts.items) {
    const ledger = await usualApi.accounts.ledger.query({ id: account.id });
    for (const entry of ledger.balances.flatMap((balance) => balance.entries)) {
      if ((await usualApi.payments.get.query({ id: entry.paymentId })).receipt?.state === "sent") {
        smtpId = entry.paymentId;
        break;
      }
    }
    if (smtpId) break;
  }
  if (!smtpId) throw new Error("Expected a delivered receipt in the SMTP demo");

  const { db, dispose } = await createTestDatabase();
  let server: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    const settings = hostedDemoEnv("http://localhost");
    const seeded = await recoverDemoSeed(
      parseEnv(
        {
          DATABASE_URL: db.connectionString,
          RELAY_DEMO: settings.RELAY_DEMO,
          RELAY_EMAIL_MODE: settings.RELAY_EMAIL_MODE,
          NODE_ENV: "production",
        },
        false,
        "maintenance",
      ),
      db.ownerConnectionString,
    );
    expect(seeded.changed).toBe(true);
    server = await serve(
      (origin) => ({ ...settings, AUTH_URL: origin, RELAY_SANDBOX_URL: origin }),
      db.connectionString,
      true,
    );
    const url = server.url("");
    await page.context().setExtraHTTPHeaders({ "x-forwarded-for": "192.0.2.100" });
    const email = "visitor@example.com";
    const code = { email, otp: "123456" };
    const send = { email, type: "sign-in" };
    for (const [path, data] of [
      ["email-otp/send-verification-otp", send],
      ["sign-in/email-otp", code],
      ["native/send-code", { email }],
      ["native/sign-in", code],
    ] as const) {
      const endpoint = `${url}/api/auth/${path}`;
      const headers = path.startsWith("native") ? {} : { origin: url };
      expect((await page.request.post(endpoint, { headers, data })).status()).toBe(404);
      expect((await page.request.post(endpoint, { headers, form: data })).status()).toBe(404);
    }
    expect(await db.ownerRows("SELECT * FROM auth_verifications")).toEqual([]);
    await page.context().clearCookies();
    await signIn(page, "agent", url);
    const api = rpc(page, url);
    const accounts = await api.accounts.list.query({ limit: 20 });
    const account = accounts.items.find((item) => item.paymentInProgress === null);
    if (!account) throw new Error("Expected a demo account");
    const payment = await api.payments.createCheckout.mutate({
      key: randomUUID(),
      accountId: account.id,
      amount: "100",
      currency: "GBP",
      kind: "repeat",
      mode: "drop",
    });
    const checkout = payment.checkout.url;
    if (!checkout) throw new Error("Expected a checkout link");
    await page.goto(checkout);
    await expect(page.getByText(hostedRecoveryNote, { exact: true })).toBeVisible();
    expect(
      (
        await page.request.post(checkout, { headers: { origin: url }, form: { mode: "drop" } })
      ).ok(),
    ).toBe(true);
    await page.goto(`${url}/payments/${payment.paymentId}`);
    await expect(page.getByText(hostedRecoveryNote, { exact: true })).toBeVisible();
    await expect(page.getByText("Check interval", { exact: true })).toHaveCount(0);
    const scheduled = await page.request.post(`${url}/api/demo/jobs`, {
      headers: { authorization: `Bearer ${settings.CRON_SECRET}` },
    });
    expect(scheduled.ok(), await scheduled.text()).toBe(true);
    const settled = await api.payments.get.query({ id: payment.paymentId });
    expect(settled).toMatchObject({
      state: { status: "completed" },
      postingCount: 1,
      receipt: { state: "suppressed" },
    });

    const [retry] = await db.rows("SELECT payment_id AS id FROM outbox WHERE state='unknown'");
    const retryId = retry?.id;
    if (typeof retryId !== "string")
      throw new Error("Expected a demo receipt with unknown delivery");
    await page.context().clearCookies();
    await signIn(page, "accountant", url);
    const accountantApi = rpc(page, url);
    expect((await accountantApi.payments.get.query({ id: retryId })).actions.requeueReceipt).toBe(
      false,
    );
    await page.goto(`${url}/payments/${retryId}`);
    await expect(page.getByRole("region", { name: "Receipt", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send again", exact: true })).toHaveCount(0);
    await expect(
      accountantApi.payments.requeueReceipt.mutate({ id: retryId }),
    ).rejects.toMatchObject({
      data: { code: "FORBIDDEN", accessFailure: "accessDenied" },
    });
    expect(await db.rows("SELECT state FROM outbox WHERE payment_id=$1", [retryId])).toEqual([
      { state: "unknown" },
    ]);

    const direct = await serve(
      (origin) => ({
        ...settings,
        AUTH_URL: origin,
        RELAY_SANDBOX_URL: origin,
        RELAY_TRUSTED_PROXY_COUNT: "0",
      }),
      db.connectionString,
    );
    try {
      const response = await fetch(direct.url("/api/auth/demo"), {
        method: "POST",
        headers: { origin: direct.url(""), "content-type": "application/json" },
        body: JSON.stringify({ role: "agent" }),
      });
      expect(response.status, await response.text()).toBe(200);
    } finally {
      await direct.stop();
    }

    await mkdir(screenshots, { recursive: true });
    for (const [size, viewport] of [
      ["desktop", { width: 1440, height: 900 }],
      ["phone", { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(viewport);
      await captureSignIn(page, smtpUrl, "smtp", size);
      await expect(page.getByRole("button", { name: "Send me a code", exact: true })).toBeVisible();
      await signIn(page, "accountant");
      const smtpPanel = await captureReceipt(page, smtpUrl, smtpId, "smtp", size);
      await expect(smtpPanel.getByText("Sent", { exact: true }).first()).toBeVisible();

      await captureSignIn(page, url, "disabled", size);
      await expect(
        page.getByText("Choose a demo person to sign in. Email codes are disabled."),
      ).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Work email" })).toHaveCount(0);
      await signIn(page, "accountant", url);
      const panel = await captureReceipt(page, url, payment.paymentId, "disabled", size);
      await expect(panel).toContainText("Receipt email is disabled in this demo.");
      await expect(panel).toContainText("Not sent");
      await expect(panel.getByRole("button", { name: "Send again" })).toHaveCount(0);
    }
  } finally {
    await server?.stop();
    await dispose();
  }
});
