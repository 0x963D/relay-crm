import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const TESTS = ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"];
const INTEGRATION_TESTS = ["packages/*/test/**/*.int.test.ts", "apps/*/test/**/*.int.test.ts"];
const PRODUCTION_TESTS = ["apps/*/test/**/*.prod.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          env: { EXPO_PUBLIC_RELAY_URL: "http://localhost:3107" },
          include: TESTS,
          exclude: [...INTEGRATION_TESTS, ...PRODUCTION_TESTS],
        },
      },
      {
        resolve: { alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) } },
        test: {
          name: "integration",
          env: { EXPO_PUBLIC_RELAY_URL: "http://localhost:3107" },
          fileParallelism: false,
          include: INTEGRATION_TESTS,
          globalSetup: ["packages/store/src/testing/global-setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: "production",
          fileParallelism: false,
          globalSetup: ["packages/store/src/testing/global-setup.ts"],
          include: PRODUCTION_TESTS,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
