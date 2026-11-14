import { defineConfig } from "vitest/config";

const TESTS = ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"];
const INTEGRATION_TESTS = ["packages/*/test/**/*.int.test.ts", "apps/*/test/**/*.int.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: TESTS,
          exclude: INTEGRATION_TESTS,
        },
      },
      {
        test: {
          name: "integration",
          include: INTEGRATION_TESTS,
          globalSetup: ["packages/store/src/testing/global-setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
