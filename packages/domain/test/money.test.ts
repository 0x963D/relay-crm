import { describe, expect, it } from "vitest";
import {
  addMoney,
  CURRENCIES,
  CurrencyMismatchError,
  formatAmount,
  isCurrencyCode,
  parseAmount,
  type CurrencyCode,
} from "../src/index.ts";

describe("parseAmount", () => {
  it.each<[string, CurrencyCode, bigint]>([
    ["12.50", "USD", 1250n],
    ["12.5", "USD", 1250n],
    ["12", "USD", 1200n],
    ["0.05", "EUR", 5n],
    ["007", "GBP", 700n],
    ["7", "JPY", 7n],
    ["1.005", "KWD", 1005n],
    ["90071992547409930.01", "USD", 9007199254740993001n],
  ])("reads %s %s as %d minor units", (decimal, currency, minor) => {
    expect(parseAmount(decimal, currency)).toEqual({ minor, currency });
  });

  it.each<[string, string, CurrencyCode]>([
    ["more fraction digits than the currency has", "1.005", "USD"],
    ["a fraction in a currency without one", "7.0", "JPY"],
    ["a minus sign", "-1.00", "USD"],
    ["a plus sign", "+1.00", "USD"],
    ["an exponent", "1e3", "USD"],
    ["a thousands separator", "1,000.00", "USD"],
    ["a missing whole part", ".50", "USD"],
    ["a missing fraction", "1.", "USD"],
    ["surrounding whitespace", " 1.00", "USD"],
    ["an empty string", "", "USD"],
  ])("refuses %s", (_label, decimal, currency) => {
    expect(parseAmount(decimal, currency)).toBeNull();
  });
});

describe("formatAmount", () => {
  it.each<[bigint, CurrencyCode, string]>([
    [1250n, "USD", "12.50"],
    [5n, "USD", "0.05"],
    [0n, "USD", "0.00"],
    [7n, "JPY", "7"],
    [1005n, "KWD", "1.005"],
    [-1250n, "USD", "-12.50"],
    [-5n, "USD", "-0.05"],
    [9007199254740993001n, "USD", "90071992547409930.01"],
  ])("writes %d %s as %s", (minor, currency, decimal) => {
    expect(formatAmount({ minor, currency })).toBe(decimal);
  });

  it("round-trips every amount it writes, in every supported currency", () => {
    for (const currency of Object.keys(CURRENCIES).filter(isCurrencyCode)) {
      for (const minor of [0n, 1n, 9n, 10n, 99n, 100n, 1001n, 123456789n]) {
        expect(parseAmount(formatAmount({ minor, currency }), currency)).toEqual({
          minor,
          currency,
        });
      }
    }
  });
});

describe("addMoney", () => {
  it("adds amounts in one currency", () => {
    expect(addMoney({ minor: 1250n, currency: "USD" }, { minor: 50n, currency: "USD" })).toEqual({
      minor: 1300n,
      currency: "USD",
    });
  });

  it("throws when the currencies differ", () => {
    expect(() => addMoney({ minor: 1n, currency: "USD" }, { minor: 1n, currency: "EUR" })).toThrow(
      CurrencyMismatchError,
    );
  });
});

describe("isCurrencyCode", () => {
  it("accepts a supported code and refuses anything else", () => {
    expect(isCurrencyCode("USD")).toBe(true);
    expect(isCurrencyCode("usd")).toBe(false);
    expect(isCurrencyCode("XXX")).toBe(false);
    expect(isCurrencyCode("toString")).toBe(false);
  });
});
