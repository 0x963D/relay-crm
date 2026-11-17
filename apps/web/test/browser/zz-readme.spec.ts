import { readFile, writeFile } from "node:fs/promises";
import setup from "./setup.ts";
import { test, expect } from "@playwright/test";
import { readmeJourney } from "./readme-journey.ts";
import { browserState, stateFile } from "./paths.ts";

test("README steps use the published controls", async ({ page }) => {
  const previous = await readFile(stateFile, "utf8");
  const dispose = await setup();
  try {
    await readmeJourney(page, async () => {
      const response = await page.request.post(`${browserState().url}/api/payments/reconcile`, {
        headers: {
          authorization: "Bearer fake-browser-reconcile-secret-abcdefghijklmnopqrstuvwxyz",
        },
      });
      expect(response.ok()).toBe(true);
    });
  } finally {
    await page.goto("about:blank");
    await dispose();
    await writeFile(stateFile, previous);
  }
});
