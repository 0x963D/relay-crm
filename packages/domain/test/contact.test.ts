import { describe, expect, it } from "vitest";
import { normalizeName, normalizePhone } from "../src/index.ts";

describe("normalizeName", () => {
  it.each<[string, string | null | undefined, string | null]>([
    ["keeps a plain name", "Ana Silva", "Ana Silva"],
    ["trims the ends", "  Ana Silva \n", "Ana Silva"],
    ["collapses inner whitespace", "Ana \t  Silva", "Ana Silva"],
    ["turns a line break into a space", "Ana\nSilva", "Ana Silva"],
    ["drops a NUL character", "Ana\u0000Silva", "Ana Silva"],
    ["reads an empty string as no name", "", null],
    ["reads whitespace as no name", " \t ", null],
    ["reads null as no name", null, null],
    ["reads undefined as no name", undefined, null],
  ])("%s", (_label, input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });

  it("clips to 200 characters without splitting a surrogate pair", () => {
    const name = normalizeName("😀".repeat(250));
    expect(name).toBe("😀".repeat(200));
  });

  it("leaves no trailing space when the clip lands after one", () => {
    expect(normalizeName(`${"a".repeat(199)} b`)).toBe("a".repeat(199));
  });
});

describe("normalizePhone", () => {
  it.each<[string, string | null | undefined, string | null]>([
    ["keeps the number as typed", "+44 20 7946 0958", "+44 20 7946 0958"],
    ["trims the ends", " 020 7946 0958 ", "020 7946 0958"],
    ["keeps an extension", "555-0100 ext. 12", "555-0100 ext. 12"],
    ["reads an empty string as no phone", "", null],
    ["reads undefined as no phone", undefined, null],
  ])("%s", (_label, input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it("clips to 40 characters", () => {
    expect(normalizePhone("1".repeat(60))).toBe("1".repeat(40));
  });
});
