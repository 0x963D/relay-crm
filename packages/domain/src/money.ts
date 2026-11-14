/**
 * Supported ISO 4217 currencies and the number of digits in their minor unit.
 * Every currency type and parser derives from this table.
 */
export const CURRENCIES = {
  AED: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KWD: 3,
  USD: 2,
} as const satisfies Record<string, 0 | 2 | 3>;

export type CurrencyCode = keyof typeof CURRENCIES;

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.hasOwn(CURRENCIES, value);
}

/** An amount counted in the currency's minor unit, so arithmetic is exact. */
export interface Money {
  readonly minor: bigint;
  readonly currency: CurrencyCode;
}

export class CurrencyMismatchError extends Error {
  override readonly name = "CurrencyMismatchError";

  constructor(left: CurrencyCode, right: CurrencyCode) {
    super(`Cannot combine ${left} with ${right}`);
  }
}

const UNSIGNED_DECIMAL = /^\d+(\.\d+)?$/;

/**
 * Reads "12.50" in USD as 1250n. It works on the digits, never on a float, and refuses a sign,
 * an exponent, or more fraction digits than the currency has. Money is never rounded.
 */
export function parseAmount(decimal: string, currency: CurrencyCode): Money | null {
  if (!UNSIGNED_DECIMAL.test(decimal)) return null;
  const [whole = "", fraction = ""] = decimal.split(".");
  const digits = CURRENCIES[currency];
  if (fraction.length > digits) return null;
  return { minor: BigInt(whole + fraction.padEnd(digits, "0")), currency };
}

/** Writes 1250n in USD as "12.50", a form `Intl.NumberFormat` accepts without losing precision. */
export function formatAmount(money: Money): string {
  const digits = CURRENCIES[money.currency];
  const sign = money.minor < 0n ? "-" : "";
  const magnitude = (money.minor < 0n ? -money.minor : money.minor).toString();
  if (digits === 0) return sign + magnitude;
  const padded = magnitude.padStart(digits + 1, "0");
  return `${sign}${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
}

/** Adding two currencies is a programming error, so it throws instead of returning a Result. */
export function addMoney(left: Money, right: Money): Money {
  if (left.currency !== right.currency) {
    throw new CurrencyMismatchError(left.currency, right.currency);
  }
  return { minor: left.minor + right.minor, currency: left.currency };
}
