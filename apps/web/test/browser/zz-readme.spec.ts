import { test, expect } from "@playwright/test";
import { readmeJourney } from "./readme-journey.ts";
import { browserState } from "./paths.ts";

test("README steps use the published controls", async ({ page }) => {
  await readmeJourney(page, async () => {
    const response = await page.request.post(`${browserState().url}/api/payments/reconcile`, {
      headers: { authorization: "Bearer fake-browser-reconcile-secret-abcdefghijklmnopqrstuvwxyz" },
    });
    expect(response.ok()).toBe(true);
  });
});
