import { test, expect } from "@playwright/test";
import { rpc, signIn } from "./support.ts";
import { browserState } from "./paths.ts";

test("payment panes keep their proportions and status phrases stay on one line", async ({
  page,
}) => {
  await signIn(page, "accountant");
  const payments = await rpc(page).payments.list.query({ limit: 100 });
  const ids = [
    payments.waitingForApproval[0]?.id,
    payments.waitingForProvider[0]?.id,
    payments.decidedThisWeek.find((row) => row.state.status === "completed")?.id,
  ];
  const widths: number[] = [];
  for (const id of ids) {
    if (!id) throw new Error("Missing payment state");
    await page.goto(`${browserState().url}/payments/${id}`);
    await expect(page.getByRole("article", { name: "Payment detail" })).toBeVisible();
    widths.push(
      (await page.getByRole("region", { name: "Payments", exact: true }).boundingBox())?.width ?? 0,
    );
    for (const badge of await page.locator('[data-slot="badge"]:visible').all())
      expect
        .soft(await badge.evaluate((element) => getComputedStyle(element).whiteSpace))
        .toBe("nowrap");
  }
  expect(new Set(widths).size).toBe(1);
});
