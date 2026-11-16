import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import superjson from "superjson";
import type { AppRouter } from "../../src/server/rpc.ts";
import { browserState, browserDirectory } from "./paths.ts";
export function rpc(page: Page) {
  const { url } = browserState();
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${url}/api/trpc`,
        transformer: superjson,
        headers: async () => ({
          origin: url,
          cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; "),
        }),
      }),
    ],
  });
}
export async function signIn(page: Page, role: "manager" | "agent" | "accountant") {
  await page.goto(browserState().url);
  await page
    .getByRole("button", {
      name:
        role === "manager"
          ? "Priya Raman Manager"
          : role === "agent"
            ? "Dele Akinwale Agent"
            : "Esther Okafor Accountant",
      exact: true,
    })
    .click();
  await expect(page.getByRole("radiogroup", { name: "View the demo as" })).toBeVisible();
}
export async function accessibility(page: Page, label: string) {
  await expect(page.locator('[aria-busy="true"]:not([role="status"])')).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) =>
          Number.isFinite(animation.effect?.getComputedTiming().iterations ?? 0),
        )
        .map((animation) => animation.finished.catch(() => null)),
    );
  });
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  await mkdir(browserDirectory, { recursive: true });
  await writeFile(join(browserDirectory, `axe-${label}.json`), JSON.stringify(results, null, 2));
  expect(results.violations, `${label} accessibility violations`).toEqual([]);
}
export async function latestCode() {
  const { inbox } = browserState();
  const contents = await readFile(inbox, "utf8");
  const codes = [...contents.matchAll(/\b(\d{6})\b/g)];
  return codes.at(-1)?.[1] ?? "";
}
export async function saveAttempt(
  page: Page,
  outcome: "No answer" | "Spoke to them",
  note: string,
) {
  await page.getByRole("button", { name: "Log an attempt", exact: true }).click();
  await page.getByRole("radio", { name: new RegExp(`^${outcome}`) }).check();
  await page.getByLabel("Note", { exact: true }).fill(note);
  await page.getByRole("button", { name: "Save attempt", exact: true }).click();
  await expect(
    page.getByRole("status").filter({
      hasText: outcome === "No answer" ? "No-answer attempt saved" : "marked as contacted",
    }),
  ).toBeVisible();
}
