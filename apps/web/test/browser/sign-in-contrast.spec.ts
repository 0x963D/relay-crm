import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { browserDirectory, browserState } from "./paths.ts";
import { settleFrame } from "./support.ts";

test("visible code-entry text meets the board contrast rule", async ({ page }) => {
  await page.goto(browserState().signInUrl);
  await page.getByLabel("Work email").fill("priya.raman@tidewell.example");
  await page.getByRole("button", { name: "Send me a code", exact: true }).click();
  const measurements = [];
  for (const theme of ["light", "dark"]) {
    await page.getByLabel("Appearance", { exact: true }).selectOption(theme);
    for (const state of ["sign-in-code", "code-refused", "code-refused-capture"]) {
      await page.getByLabel("6-digit code").fill(state === "sign-in-code" ? "417" : "000000");
      if (state !== "sign-in-code") {
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toBeVisible();
        await page.getByLabel("6-digit code").fill("417");
      }
      await settleFrame(page);
      const pairs = await page.getByRole("main").evaluate((main) =>
        [...main.querySelectorAll("p, [data-slot=input-otp-slot], [role=alert]")].map((element) => {
          const style = getComputedStyle(element);
          let parent: Element | null = element;
          let background = "rgba(0, 0, 0, 0)";
          while (parent && background === "rgba(0, 0, 0, 0)") {
            background = getComputedStyle(parent).backgroundColor;
            parent = parent.parentElement;
          }
          return { text: element.textContent, foreground: style.color, background };
        }),
      );
      for (const pair of pairs) {
        const luminance = (rgb: string) => {
          const channels = (rgb.match(/[\d.]+/g) ?? [])
            .slice(0, 3)
            .map(Number)
            .map((v) => {
              const s = v / 255;
              return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            });
          return (
            (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722
          );
        };
        const values = [luminance(pair.foreground), luminance(pair.background)].sort(
          (a, b) => b - a,
        );
        const ratio = ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
        measurements.push({ theme, state, ...pair, ratio });
        expect(ratio, `${theme} ${state} ${pair.text}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
  await mkdir(browserDirectory, { recursive: true });
  await writeFile(
    join(browserDirectory, "sign-in-contrast.json"),
    JSON.stringify(measurements, null, 2),
  );
});
