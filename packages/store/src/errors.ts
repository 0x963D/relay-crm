import { ACCESS_FAILURES, type AccessFailure } from "@relay/domain";

export class AccessError extends Error {
  override readonly name = "AccessError";
  readonly code: AccessFailure;
  constructor(code: AccessFailure) {
    super(code);
    this.code = code;
  }
}

// Page and API bundles can hold different constructors for the shared store.
export function isAccessError(value: unknown): value is AccessError {
  if (!(value instanceof Error) || value.name !== "AccessError") return false;
  const code: unknown = Reflect.get(value, "code");
  return typeof code === "string" && ACCESS_FAILURES.some((failure) => failure === code);
}
