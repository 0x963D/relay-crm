import { test, expect, type Locator, type Page } from "@playwright/test";
import { accessibility, signIn, tabTo } from "./support.ts";

async function activate(page: Page, control: Locator, keyboard: boolean) {
  if (keyboard) {
    await tabTo(page, control);
    await page.keyboard.press("Enter");
  } else await control.click();
}
for (const role of ["agent", "manager", "accountant"] as const) {
  for (const width of [1440, 1280, 1024, 390]) {
    for (const theme of ["light", "dark"] as const) {
      test(`${role} screens at ${String(width)} in ${theme}, by mouse and keyboard`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await signIn(page, role);
        await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption(theme);
        for (const keyboard of [false, true]) {
          const navigation = page.getByRole("navigation", { name: "Main", exact: true });
          if (role === "agent") {
            await activate(
              page,
              navigation.getByRole("link", { name: "My queue", exact: true }),
              keyboard,
            );
            await activate(
              page,
              page.getByRole("link", { name: "Open Hye-jin Park", exact: true }),
              keyboard,
            );
            await activate(
              page,
              page.getByRole("button", { name: "Add note", exact: true }),
              keyboard,
            );
            const note = page.getByRole("textbox", { name: "Note", exact: true });
            if (keyboard) {
              await tabTo(page, note);
              await page.keyboard.type("Customer requested an evening call.");
            } else await note.fill("Customer requested an evening call.");
            await activate(
              page,
              page.getByRole("button", { name: "Save note", exact: true }),
              keyboard,
            );
            await expect(page.getByRole("status").filter({ hasText: "Note added" })).toBeFocused();
            await accessibility(
              page,
              `lead-${String(width)}-${theme}-${keyboard ? "keys" : "mouse"}`,
            );
          } else if (role === "manager") {
            await activate(
              page,
              navigation.getByRole("link", { name: "Lead pool", exact: true }),
              keyboard,
            );
            const lead = page.getByRole("checkbox", { name: /^Select / }).nth(1);
            if (keyboard) {
              await tabTo(page, lead);
              await page.keyboard.press("Space");
            } else await lead.check();
            if (width < 768)
              await activate(
                page,
                page.getByRole("button", { name: "Assign 1 selected lead", exact: true }),
                keyboard,
              );
            if (keyboard) {
              await tabTo(page, page.getByRole("tab", { name: "To one person", exact: true }));
              await page.keyboard.press("ArrowRight");
            } else await page.getByRole("tab", { name: "Round-robin", exact: true }).click();
            await activate(
              page,
              page.getByRole("button", { name: "Preview 1 lead", exact: true }),
              keyboard,
            );
            await expect(page.getByRole("heading", { name: "Preview", exact: true })).toBeFocused();
            await accessibility(
              page,
              `pool-${String(width)}-${theme}-${keyboard ? "keys" : "mouse"}`,
            );
          }
          await activate(
            page,
            navigation.getByRole("link", { name: "Payments", exact: true }),
            keyboard,
          );
          await expect(page.getByRole("heading", { name: "Payments", exact: true })).toBeVisible();
          const payment = page
            .getByRole("region", { name: "Payments", exact: true })
            .getByRole("link")
            .first();
          await activate(page, payment, keyboard);
          await expect(
            page.getByRole("article", { name: "Payment detail", exact: true }),
          ).toBeVisible();
          await accessibility(
            page,
            `payment-${role}-${String(width)}-${theme}-${keyboard ? "keys" : "mouse"}`,
          );
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          await activate(
            page,
            navigation.getByRole("link", { name: "Accounts", exact: true }),
            keyboard,
          );
          await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
          await activate(
            page,
            page.getByRole("region", { name: "Accounts", exact: true }).getByRole("link").first(),
            keyboard,
          );
          const back = page.getByRole("link", { name: "Back to accounts", exact: true });
          if (width < 1280) await expect(back).toBeVisible();
          else await expect(back).toBeHidden();
          if (role === "agent") {
            await expect(page.getByRole("link", { name: "Open ledger", exact: true })).toHaveCount(
              0,
            );
            await expect(page.getByText("Balance", { exact: true })).toHaveCount(0);
            await activate(
              page,
              page.getByRole("link", { name: "Create card checkout", exact: true }),
              keyboard,
            );
            await expect(
              page.getByRole("heading", { name: "Create a card checkout", exact: true }),
            ).toBeVisible();
          } else {
            await activate(
              page,
              page.getByRole("link", { name: "Open ledger", exact: true }),
              keyboard,
            );
            await expect(
              page.getByRole("region", { name: "Account ledger", exact: true }),
            ).toBeVisible();
          }
          await accessibility(
            page,
            `account-${role}-${String(width)}-${theme}-${keyboard ? "keys" : "mouse"}`,
          );
          if (role === "manager") {
            await activate(
              page,
              navigation.getByRole("link", { name: "Campaign funnel", exact: true }),
              keyboard,
            );
            await expect(
              page.getByRole("heading", { name: "Campaign funnel", exact: true }),
            ).toBeVisible();
            await accessibility(
              page,
              `funnel-${String(width)}-${theme}-${keyboard ? "keys" : "mouse"}`,
            );
          }
        }
      });
    }
  }
}
