import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { expect, type Page, type Locator, type BrowserContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import superjson from "superjson";
import { z } from "zod";
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
const sessions = new Map<string, Awaited<ReturnType<BrowserContext["cookies"]>>>();
export async function signIn(page: Page, role: "manager" | "agent" | "accountant") {
  const { url } = browserState();
  const key = `${url}:${role}`;
  const cookies = sessions.get(key);
  if (cookies) await page.context().addCookies(cookies);
  await page.goto(url);
  const login = page.getByRole("button", {
    name:
      role === "manager"
        ? "Priya Raman Manager"
        : role === "accountant"
          ? "Esther Okafor Accountant"
          : "Dele Akinwale Agent",
    exact: true,
  });
  if (!cookies || (await login.isVisible())) {
    await login.click();
    await expect(page.getByRole("radiogroup", { name: "View the demo as" })).toBeVisible();
    sessions.set(key, await page.context().cookies());
  }
  await expect(
    page.getByRole("radio", {
      name: role === "manager" ? "Manager" : role === "accountant" ? "Accountant" : "Agent",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    page.getByRole("heading", {
      name: role === "manager" ? "Lead pool" : role === "accountant" ? "Payments" : "My queue",
      exact: true,
    }),
  ).toBeVisible();
}
export async function settleFrame(page: Page) {
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
}
export async function accessibility(page: Page, label: string) {
  await expect
    .poll(() =>
      page
        .getByRole("button")
        .evaluateAll((buttons) =>
          buttons.some((button) => button.getAttribute("aria-busy") === "true"),
        ),
    )
    .toBe(false);
  await settleFrame(page);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  await mkdir(browserDirectory, { recursive: true });
  await writeFile(join(browserDirectory, `axe-${label}.json`), JSON.stringify(results, null, 2));
  expect(results.violations, `${label} accessibility violations`).toEqual([]);
  expect(
    results.incomplete.filter((rule) => rule.id !== "color-contrast"),
    `${label} unresolved accessibility structure`,
  ).toEqual([]);
}
export async function latestCode() {
  const { inbox } = browserState();
  let contents: string;
  if (inbox.startsWith("http://")) {
    const listing: unknown = await (await fetch(`${inbox}/api/v1/messages`)).json();
    const messages = z
      .object({ messages: z.array(z.object({ ID: z.string() })) })
      .parse(listing).messages;
    contents = "";
    for (const message of messages) {
      const raw: unknown = await (await fetch(`${inbox}/api/v1/message/${message.ID}`)).json();
      const text = z.object({ Text: z.string() }).parse(raw).Text;
      if (/Your sign-in code is \d{6}\./.test(text)) {
        contents = text;
        break;
      }
    }
  } else contents = await readFile(inbox, "utf8");
  const codes = [...contents.matchAll(/Your sign-in code is (\d{6})\./g)];
  return codes.at(-1)?.[1] ?? "";
}
export async function saveAttempt(
  page: Page,
  outcome: "No answer" | "Spoke to them",
  note: string,
) {
  await page.getByRole("button", { name: "Log an attempt", exact: true }).click();
  await page.getByRole("radio", { name: new RegExp(`^${outcome}`) }).check();
  await page.getByRole("textbox", { name: "Note", exact: true }).fill(note);
  await page.getByRole("button", { name: "Save attempt", exact: true }).click();
  await expect(
    page.getByRole("status").filter({
      hasText: outcome === "No answer" ? "No-answer attempt saved" : "marked as contacted",
    }),
  ).toBeVisible();
}

export async function tabTo(page: Page, target: Locator) {
  for (let count = 0; count < 80; count++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}
