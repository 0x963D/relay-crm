import { test, expect } from "@playwright/test";
import { signIn } from "./support.ts";
import { captureDirectory } from "./paths.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

test("manager phone navigation fits one row with every destination visible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "manager");
  const nav = page.getByRole("navigation", { name: "Main" });
  const boxes = await nav.getByRole("link").evaluateAll((links) =>
    links.map((link) => {
      const rect = link.getBoundingClientRect();
      return { top: rect.top, left: rect.left, right: rect.right, height: rect.height };
    }),
  );
  expect(new Set(boxes.map((box) => box.top)).size).toBe(1);
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(390);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await mkdir(captureDirectory, { recursive: true });
  await page.screenshot({ path: join(captureDirectory, "manager-phone.png") });
});
