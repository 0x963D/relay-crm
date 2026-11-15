import type { AccessFailure } from "@relay/domain";

export class AccessError extends Error {
  override readonly name = "AccessError";
  readonly code: AccessFailure;
  constructor(code: AccessFailure) {
    super(code);
    this.code = code;
  }
}
