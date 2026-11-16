import type { AccessFailure } from "./distribution.ts";

export class AccessError extends Error {
  override readonly name = "AccessError";
  readonly code: AccessFailure;
  constructor(code: AccessFailure) {
    const messages: Partial<Record<AccessFailure, string>> = {
      pendingPayment: "This account already has a payment waiting for approval.",
      receiptUsed: "This receipt was already used for a payment.",
      paymentMaker: "You last edited this payment and cannot approve it.",
      paymentRecorder: "You recorded this payment and cannot approve it.",
      alreadyApproved: "You already approved this payment.",
      roleChanged: "Your role changed. Refresh before deciding on this payment.",
      refreshConflict: "This payment changed. Refresh before trying again.",
    };
    super(
      messages[code] ??
        (code === "idempotencyConflict"
          ? "The key was already used for a different request."
          : code === "teamSelectionRequired"
            ? "Choose a current team before using team-scoped operations."
            : code),
    );
    this.code = code;
  }
}
