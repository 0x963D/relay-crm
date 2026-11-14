import { describe, expect, expectTypeOf, it } from "vitest";
import { LeadId, type AccountId } from "../src/index.ts";

describe("branded IDs", () => {
  it.each([
    ["a version 7 UUID", "019a8e2c-7d4b-7c1e-9f3a-0b1c2d3e4f50"],
    ["a version 4 UUID", "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b"],
  ])("accepts %s", (_label, value) => {
    expect(LeadId.is(value)).toBe(true);
    expect(LeadId.parse(value)).toBe(value);
  });

  it.each([
    ["an empty string", ""],
    ["uppercase hex", "019A8E2C-7D4B-7C1E-9F3A-0B1C2D3E4F50"],
    ["no hyphens", "019a8e2c7d4b7c1e9f3a0b1c2d3e4f50"],
    ["a version 0 UUID", "00000000-0000-0000-0000-000000000000"],
    ["a variant outside RFC 4122", "019a8e2c-7d4b-7c1e-cf3a-0b1c2d3e4f50"],
    ["surrounding whitespace", " 019a8e2c-7d4b-7c1e-9f3a-0b1c2d3e4f50 "],
    ["a trailing line break", "019a8e2c-7d4b-7c1e-9f3a-0b1c2d3e4f50\n"],
  ])("refuses %s", (_label, value) => {
    expect(LeadId.is(value)).toBe(false);
    expect(LeadId.parse(value)).toBeNull();
  });

  it("keeps one kind of ID from standing in for another", () => {
    expectTypeOf<LeadId>().not.toExtend<AccountId>();
    expectTypeOf<AccountId>().not.toExtend<LeadId>();
    expectTypeOf<string>().not.toExtend<LeadId>();
    expectTypeOf<LeadId>().toExtend<string>();
  });
});
