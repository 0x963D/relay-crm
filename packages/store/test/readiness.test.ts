import { readdirSync } from "node:fs";
import { expect, test } from "vitest";
import { REQUIRED_MIGRATION } from "../src/demo-state.ts";

test("readiness requires the newest migration shipped by this build", () => {
  const migrations = readdirSync(new URL("../prisma/migrations/", import.meta.url), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  expect(REQUIRED_MIGRATION).toBe(migrations.at(-1));
});
