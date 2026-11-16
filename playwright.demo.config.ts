import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";
export default defineConfig({
  ...base,
  globalSetup: [],
  globalTimeout: 900000,
  testMatch: [
    "**/payments.spec.ts",
    "**/screens.spec.ts",
    "**/journeys.spec.ts",
    "**/foundation.spec.ts",
    "**/patterns.spec.ts",
  ],
  grep: /card checkout recovers|manual payment|all five sandbox|screens at|a public enquiry|an agent records|keyboard alone|keyboard assignment|an offline save|paging keeps the queue/,
  grepInvert: /@capture/,
});
