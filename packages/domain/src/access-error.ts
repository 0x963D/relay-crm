import type { AccessFailure } from "./distribution.ts";

export class AccessError extends Error {
  override readonly name = "AccessError";
  readonly code: AccessFailure;
  constructor(code: AccessFailure) {
    super(
      code === "idempotencyConflict"
        ? "The key was already used for a different request."
        : code === "teamSelectionRequired"
          ? "Choose a current team before using team-scoped operations."
          : code,
    );
    this.code = code;
  }
}
