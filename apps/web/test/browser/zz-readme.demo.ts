import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { signIn, rpc } from "./support.ts";
import { readmeJourney } from "./readme-journey.ts";
import { browserState, captureDirectory } from "./paths.ts";

test("README journeys work through the browser with scheduled recovery", async ({ page }) => {
  test.setTimeout(180000);
  await mkdir(captureDirectory, { recursive: true });
  await signIn(page, "accountant");
  const api = rpc(page);
  const payments = await api.payments.list.query({ limit: 100 });
  const late = payments.needsReview.find(
    (payment) =>
      payment.state.status === "needsReview" && payment.state.reason === "paid after close",
  );
  const waiting = payments.waitingForProvider.find(
    (payment) => payment.account?.name === "Marek Novak",
  );
  const account = (await api.accounts.list.query({ limit: 100 })).items.find(
    (row) => row.person?.name === "Jonas Weber",
  );
  if (!late || !waiting || !account) throw new Error("Missing seeded payment stories.");
  const ledger = await api.accounts.ledger.query({ id: account.id });
  const recovered = ledger.balances
    .flatMap((balance) => balance.entries)
    .find((entry) => entry.completion.by === "reconciler");
  if (!recovered) throw new Error("Missing seeded reconciler payment.");
  for (const [name, id] of [
    ["paid-after-close", late.id],
    ["waiting", waiting.id],
    ["reconciled", recovered.paymentId],
  ] as const) {
    await page.goto(`${browserState().url}/payments/${id}`);
    const events = page.getByRole("list", { name: "Payment events" });
    await expect(events.getByRole("heading").first()).toHaveText("Checkout created");
    if (name === "paid-after-close") {
      await expect(events.getByRole("heading")).toHaveText([
        "Checkout created",
        "The reconciler asked the provider",
        "Payment closed as expired",
        "The webhook arrived late",
        "Moved to needs review",
      ]);
      await expect(page.getByRole("region", { name: "Review comparison" })).toContainText(
        "The amount and the currency match.",
      );
    } else if (name === "waiting") {
      await expect(events).not.toContainText("No webhook was recorded");
      await expect(events.getByRole("heading").last()).toContainText("checks changed nothing");
    } else {
      await expect(events.getByRole("heading")).toHaveText([
        "Checkout created",
        "No webhook was recorded before this check",
        "The reconciler asked the provider",
        "The payment was completed",
        "The webhook arrived late",
      ]);
    }
    await page.screenshot({ path: join(captureDirectory, `${name}.png`), fullPage: true });
  }
  await readmeJourney(page);
});
