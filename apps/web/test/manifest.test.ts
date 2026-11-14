import { describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };

describe("the web app's manifest", () => {
  it("declares no database client, so the app can only reach data through the store", () => {
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });

    expect(
      declared.filter((name) => name === "pg" || name === "prisma" || name.startsWith("@prisma/")),
    ).toEqual([]);
  });
});
