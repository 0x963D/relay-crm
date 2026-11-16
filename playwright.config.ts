import { defineConfig } from "@playwright/test";
import { browserDirectory } from "./apps/web/test/browser/paths.ts";
export default defineConfig({
  testDir: "./apps/web/test/browser",
  testMatch: "**/*.spec.ts",
  globalSetup: "./apps/web/test/browser/setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120000,
  globalTimeout: 600000,
  outputDir: `${browserDirectory}/artifacts`,
  reporter: [["list"], ["json", { outputFile: `${browserDirectory}/results.json` }]],
  use: {
    actionTimeout: 15000,
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    locale: "en-GB",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
