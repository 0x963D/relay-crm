import { describe, expect, it } from "vitest";
import { dark, families, light, radius, themeFor, type } from "../src/core/theme.ts";

describe("theme contract", () => {
  it("follows the system and uses light when appearance is unknown", () => {
    expect(themeFor("dark")).toBe(dark);
    expect(themeFor("light")).toBe(light);
    expect(themeFor(null)).toBe(light);
  });
  it("has the same semantic colors in both themes", () => {
    expect(Object.keys(dark)).toEqual(Object.keys(light));
  });
  it.each([
    ["carbon", "#161A52", "#0B0D29"],
    ["sheet", "#FFFFFF", "#151840"],
    ["ink", "#2433B9", "#98A3FF"],
    ["control", "#8A8FB5", "#636AA8"],
    ["controlOnTint", "#70759E", "#8D94D6"],
    ["wait", "#FFF3B0", "#3B3205"],
    ["refused", "#FCDCE3", "#4A152B"],
    ["done", "#D8F1DE", "#12381F"],
  ] as const)("pins %s", (key, a, b) => {
    expect(light[key]).toBe(a);
    expect(dark[key]).toBe(b);
  });
  it("uses five real faces with no synthetic weights", () => {
    expect(new Set(Object.values(families)).size).toBe(5);
    expect(type.display).toEqual({ fontSize: 30, lineHeight: 34, fontFamily: families.title });
    expect(type.rowTitle.fontFamily).toBe(families.semibold);
    for (const style of Object.values(type)) {
      expect(style).not.toHaveProperty("fontWeight");
      expect(style.fontSize).toBeGreaterThanOrEqual(13);
    }
  });
  it("pins control and sheet radii", () => {
    expect(radius).toEqual({ slip: 4, segment: 7, control: 10, card: 12, sheet: 20, full: 999 });
  });
});
