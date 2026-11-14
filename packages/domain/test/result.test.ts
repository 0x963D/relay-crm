import { describe, expect, it } from "vitest";
import { err, ok, type Result } from "../src/index.ts";

function half(value: number): Result<number, "odd"> {
  return value % 2 === 0 ? ok(value / 2) : err("odd");
}

describe("Result", () => {
  it("carries the value of a success", () => {
    expect(half(8)).toEqual({ ok: true, value: 4 });
  });

  it("carries the error of a refusal", () => {
    expect(half(7)).toEqual({ ok: false, error: "odd" });
  });
});
