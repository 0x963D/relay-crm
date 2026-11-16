declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function uuidBrand<B extends string>() {
  const is = (value: string): value is Brand<string, B> => UUID.test(value);
  const parse = (value: string): Brand<string, B> | null => (is(value) ? value : null);
  return { is, parse };
}

export const LeadId = uuidBrand<"LeadId">();
export type LeadId = Brand<string, "LeadId">;

export const AccountId = uuidBrand<"AccountId">();
export type AccountId = Brand<string, "AccountId">;

export const UserId = uuidBrand<"UserId">();
export type UserId = Brand<string, "UserId">;

export const TeamId = uuidBrand<"TeamId">();
export type TeamId = Brand<string, "TeamId">;

export const IntakeEventId = uuidBrand<"IntakeEventId">();
export type IntakeEventId = Brand<string, "IntakeEventId">;

export const ActivityId = uuidBrand<"ActivityId">();
export type ActivityId = Brand<string, "ActivityId">;

export const PaymentId = uuidBrand<"PaymentId">();
export type PaymentId = Brand<string, "PaymentId">;

export const LedgerTransactionId = uuidBrand<"LedgerTransactionId">();
export type LedgerTransactionId = Brand<string, "LedgerTransactionId">;
