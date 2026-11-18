import { describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };
import hosting from "../vercel.json" with { type: "json" };

describe("the web app's manifest", () => {
  it("declares no database client, so the app can only reach data through the store", () => {
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });

    expect(
      declared.filter((name) => name === "pg" || name === "prisma" || name.startsWith("@prisma/")),
    ).toEqual([]);
  });
});

it("configures one hosted POST schedule and manual Git deployments", () => {
  expect(hosting.git.deploymentEnabled).toBe(false);
  expect(hosting).not.toHaveProperty("crons");
  expect(Object.keys(hosting.schedules)).toEqual(["demo-payments"]);
  const schedule = hosting.schedules["demo-payments"];
  expect(schedule.schedule).toMatch(/^(?:\*|\*\/15) \* \* \* \*$/);
  expect(schedule.path).toBe("/api/demo/jobs");
  expect(schedule.requestMethod).toBe("POST");
  expect(manifest.engines.node).toBe("24.x");
});
