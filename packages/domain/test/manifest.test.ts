import { describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };

describe("the domain's manifest", () => {
  it("declares no dependencies, so an import of anything but its own files cannot resolve", () => {
    expect(Object.keys(manifest).filter((key) => key.endsWith("ependencies"))).toEqual([]);
  });
});
