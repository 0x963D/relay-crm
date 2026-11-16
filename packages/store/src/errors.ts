import { ACCESS_FAILURES } from "@relay/domain";

export { AccessError } from "@relay/domain";
import type { AccessError } from "@relay/domain";

// Page and API bundles can hold different constructors for the shared store.
export function isAccessError(value: unknown): value is AccessError {
  if (!(value instanceof Error) || value.name !== "AccessError") return false;
  const code: unknown = Reflect.get(value, "code");
  return typeof code === "string" && ACCESS_FAILURES.some((failure) => failure === code);
}
